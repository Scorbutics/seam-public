// READ DEMAND — which files an agent actually OPENED while answering a benchmark task.
//
// `bun bench/ranking/demand.ts [case-glob]`            → per-case summary
// `bun bench/ranking/demand.ts --json > demand.json`   → the fixture the ranking evaluator scores against
//
// WHY THIS EXISTS. Seam's intent ranking is scored today by whether it LOOKS right. The one measurement that
// did better — tier+relevance covered 30% of read demand at a top-12 budget against 58% for a crude citation
// count — rested on 78 reads from two hand-run cases whose artifacts are gone. That is not a scoreboard you
// can iterate a ranking against. The stored transcripts, though, record every `Read` the agent issued, so the
// demand is re-derivable for the WHOLE corpus, offline, without re-running a single agent.
//
// THE TWO ARMS ARE NOT THE SAME GROUND TRUTH, and conflating them would quietly rig the result:
//
//   arm B (seam) — the agent saw Seam's output and opened files FROM it. Its reads are downstream of the
//                  ranking under test. Scoring a ranking against them rewards the ranking for what it already
//                  showed: a file the current ranking buried can barely appear in this demand at all.
//   arm A (grep) — the agent never saw Seam. Its reads are what the TASK demanded, independent of any ranking.
//                  This is the honest target: the ranking's job is to put these files in the first N rows.
//
// So both are extracted and kept apart. Arm A is the one a candidate ranking should be judged on; arm B is
// reported because a ranking that misses even the files its own output steered the agent to is broken twice.
//
// WHAT COUNTS AS AN OPEN — and why it is NOT just the `Read` tool. The first version of this file counted
// `Read` only, on the reasoning that a `grep -n` is an existence probe rather than an open. Measured, that
// rule made the arm it most needed VACUOUS: across 72 arm-A transcripts there are 90 `Read` calls against
// 1385 bash reads, because run-arms.sh shims arm A down to grep-family tools and `sed -n '400,470p' <file>`
// IS how that arm opens a file. A metric that scores the treatment arm's channel and not the control's is not
// a comparison. So an OPEN is either channel, and the split is always reported: a ranking that only wins on
// one channel is a ranking that won on an artifact of the tool restrictions.
//
// EXCLUDED, and each one because it silently corrupted a count while this was being written:
//   - `~/.claude/projects/.../tool-results/*.txt` — the agent re-reading SEAM'S OWN saved output. Under the
//     repo-prefix filter these fall out naturally; they are named here because they are the single most common
//     Read in an arm-B transcript and reading them as demand would have been a ~20% error.
//   - `/tmp/*` — the same, via redirection.
//   - paths outside `--repo` — the benchmark's own scripts, the seam repo itself.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const RESULTS = join(HERE, "..", "grep-vs-seam", "results");
const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const filter = argv.find((a) => !a.startsWith("--"));

type Arm = "A" | "B";
type Raw = { case: string; arm: Arm; rawReads: string[]; cmds: string[] };
type Case = {
  case: string;
  arm: Arm;
  repo: string;
  seamCmds: string[];
  reads: string[];       // repo-relative, in issue order, WITH duplicates — re-reading a file is more demand
  bashReads: string[];   // the same, via the shell channel
  offRepo: number;       // reads that landed outside the repo (tool-results, /tmp, harness files)
};

/// THE REPO IS A PROPERTY OF THE CASE, NOT OF THE ARM, and resolving it per-arm was the first version's worst
/// bug. `--repo <p>` is only ever passed to Seam, so arm A — which has no seam invocation — fell through to a
/// `cd <dir> &&` fallback and resolved to whatever subdirectory the agent happened to enter first
/// (`js/libs/keycloak-admin-client`, `src`, …). Every read outside that subtree was then discarded as
/// off-repo, which is how 443 arm-B reads collapsed to 31 distinct files and arm A looked like it read almost
/// nothing. So: `--repo` wins wherever in the CASE it appears, `cd` is a last resort, and both arms of a case
/// share the answer.
/// A RELATIVE `--repo` IS NOT A REPO ROOT. Three cases (base-r3, clean-r2, fix3-r1) pass `--repo .`; taking it
/// literally set the root to "." so every ABSOLUTE Read path failed the prefix test and was discarded as
/// off-repo, while bare relative shell paths sailed through — a case that silently lost one whole channel.
/// So absolute forms are preferred, and a relative one is resolved against the `cd` that preceded it.
function repoOf(cmds: string[]): string {
  const abs = (p: string) => p.startsWith("/");
  for (const c of cmds) { const m = c.match(/--repo\s+(\S+)/); if (m && abs(m[1])) return m[1].replace(/\/+$/, ""); }
  for (const c of cmds) { const m = c.match(/cd\s+(\/\S+?)\s*&&/); if (m) return m[1].replace(/\/+$/, ""); }
  return "";
}

/** A concrete source path read by a shell verb — NOT a path inside a quoted pattern (that is a string). */
function bashReadTargets(cmd: string): string[] {
  const unquoted = cmd.replace(/'[^']*'|"[^"]*"/g, " ");
  const out: string[] = [];
  for (const m of unquoted.matchAll(/\b(?:cat|sed|head|tail|less|grep|rg)\b[^|;&]*?\s(\/?[\w./@-]+\.(?:tsx?|jsx?|mjs|cjs|java|rb|py|go|rs|kt|php|c|cc|cpp|h|hpp|sql|ftl|json|ya?ml))\b/g))
    out.push(m[1]);
  return out;
}

function parse(path: string, caseId: string, arm: Arm): Raw {
  const rawReads: string[] = [];
  const cmds: string[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const content = d?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== "tool_use") continue;
      if (c.name === "Read" && typeof c.input?.file_path === "string") rawReads.push(c.input.file_path);
      if (c.name === "Bash" && typeof c.input?.command === "string") cmds.push(c.input.command);
    }
  }
  return { case: caseId, arm, rawReads, cmds };
}

/** Normalize one arm's raw accesses against the CASE's repo (resolved across both arms — see repoOf). */
function resolve(raw: Raw, repo: string): Case {
  const rel = (p: string): string | null => (p.startsWith(repo + "/") ? p.slice(repo.length + 1) : null);
  const reads: string[] = [];
  const bash: string[] = [];
  let offRepo = 0;
  for (const p of raw.rawReads) { const r = rel(p); if (r) reads.push(r); else offRepo++; }
  for (const c of raw.cmds) for (const t of bashReadTargets(c)) {
    // a bare relative path under `cd <repo> && grep …` is already repo-relative
    const r = t.startsWith("/") ? rel(t) : t;
    if (r) bash.push(r);
  }
  const seamCmds = raw.cmds.filter((c) => /decompose\.ts/.test(c) && !/--help/.test(c));
  return { case: raw.case, arm: raw.arm, repo, seamCmds, reads, bashReads: bash, offRepo };
}

// ── sweep the corpus ─────────────────────────────────────────────────────────────────────────────────────────
const files = readdirSync(RESULTS).filter((f) => /\.[AB]\.jsonl$/.test(f)).sort();
const raws: Raw[] = [];
for (const f of files) {
  const m = f.match(/^(.+)\.([AB])\.jsonl$/)!;
  if (filter && !m[1].includes(filter)) continue;
  raws.push(parse(join(RESULTS, f), m[1], m[2] as Arm));
}
const byCase = new Map<string, Raw[]>();
for (const r of raws) byCase.set(r.case, [...(byCase.get(r.case) ?? []), r]);
const cases: Case[] = [];
const noRepo: string[] = [];
for (const [id, arms] of byCase) {
  const repo = repoOf(arms.flatMap((a) => a.cmds));
  if (!repo) { noRepo.push(id); continue; }
  for (const a of arms) cases.push(resolve(a, repo));
}
cases.sort((a, b) => a.case.localeCompare(b.case) || a.arm.localeCompare(b.arm));

const opens = (c: Case) => [...c.reads, ...c.bashReads];

// A CORPUS THAT YIELDS NO DEMAND IS A BROKEN EXTRACTOR, not a finding that agents read nothing. This project
// has shipped that failure before (a gate with no case, `EXACT 0/0`); refuse to emit a fixture from it.
if (!cases.length) { console.error(`ABORT: no parsable transcripts under ${RESULTS}${filter ? ` matching '${filter}'` : ""}.`); process.exit(3); }
const totalOpens = cases.reduce((n, c) => n + opens(c).length, 0);
if (!totalOpens) { console.error(`ABORT: ${cases.length} transcript(s) parsed, 0 in-repo opens extracted. The extractor is broken.`); process.exit(3); }
// AND PER ARM, because an arm that yields nothing is not a control — it is a hole the comparison falls into,
// and that is exactly the shape the `Read`-only metric had.
for (const arm of ["A", "B"] as Arm[]) {
  const sub = cases.filter((c) => c.arm === arm);
  if (sub.length && !sub.reduce((n, c) => n + opens(c).length, 0)) {
    console.error(`ABORT: arm ${arm} has ${sub.length} transcript(s) and 0 opens. One arm cannot score against nothing.`);
    process.exit(3);
  }
}

if (asJson) { console.log(JSON.stringify(cases, null, 2)); process.exit(0); }

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────
const uniq = (a: string[]) => new Set(a).size;
console.log(`\n══════ READ DEMAND — ${cases.length} transcript(s) under ${RESULTS}\n`);
if (noRepo.length) console.log(`   ${noRepo.length} case(s) dropped, no repo resolvable: ${noRepo.join(", ")}\n`);
console.log(`   ${"case".padEnd(22)} ${"arm".padEnd(5)} ${"opens".padStart(6)} ${"uniq".padStart(5)} ${"tool".padStart(5)} ${"bash".padStart(5)} ${"seam".padStart(5)}  repo`);
for (const c of cases)
  console.log(`   ${c.case.padEnd(22)} ${(c.arm === "A" ? "grep" : "seam").padEnd(5)} ${String(opens(c).length).padStart(6)} ${String(uniq(opens(c))).padStart(5)} ${String(c.reads.length).padStart(5)} ${String(c.bashReads.length).padStart(5)} ${String(c.seamCmds.length).padStart(5)}  ${c.repo.split("/").pop()}`);

for (const arm of ["A", "B"] as Arm[]) {
  const sub = cases.filter((c) => c.arm === arm);
  const o = sub.flatMap(opens);
  console.log(`\n   ── arm ${arm} (${arm === "A" ? "grep — ranking-independent, the honest target" : "seam — downstream of the ranking under test"})`);
  console.log(`   ${sub.length} case(s), ${o.length} open(s), ${uniq(o)} distinct file(s)` +
    ` — ${sub.flatMap((c) => c.reads).length} via the Read tool, ${sub.flatMap((c) => c.bashReads).length} via the shell` +
    `, ${sub.reduce((n, c) => n + c.offRepo, 0)} off-repo discarded`);
}
console.log(`\n   An OPEN is either channel; the split is shown so a one-channel win is visible. See the header.\n`);
