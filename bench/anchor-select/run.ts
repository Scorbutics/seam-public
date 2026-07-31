// ANCHOR SELECTION — the step BEFORE every shape, and the one nothing measured.
//
//   bun bench/anchor-select/run.ts [caseId…] [--trials N]
//
// WHY THIS EXISTS. `bench/grep-vs-seam` replays the commands an agent actually ran, so it can only score answers
// to questions the agent thought to ask. Replaying the keycloak trace showed the agent never found the case's
// declared anchor at all: it guessed `--center` twice from the prose task, landed on the TypeScript side once and
// a 28-line dead end the other time, and paid 21 RECALL commands afterwards. Anchor choice is upstream of every
// shape, every ranking fix and every coupling improvement — and no harness could see it.
//
// It also settles a live disagreement with evidence instead of one sample. `--scan --intent` picks the anchor
// itself via two LLM judge passes; measured over four uncached keycloak runs those took 18s–81s and returned a
// DIFFERENT mechanism cluster on 1 run in 4 (a `centers-v1` cache exists purely to freeze one sample so grows
// stay reproducible). `--locate-intent` was then built as the deterministic alternative. Which is actually better
// was, at that point, nobody's measurement — this is it.
//
// THE ARMS MUST ALL BE ABLE TO WIN. A benchmark whose baseline cannot beat the thing being sold is an advert:
//   locate — `--locate-intent`, deterministic, offline, one call
//   judges — `--scan --intent`, the two LLM passes, run `--trials` times with the cache CLEARED each time so the
//            reported number is the distribution and not the frozen sample
//   grep   — a COMPETENT agent-style search: content words from the task, definition-seeking patterns first, then
//            plain occurrence, ranked by how many distinct task words a file matches. Not a strawman `grep foo`.
//
// SCORING IS AT FILE GRANULARITY, deliberately. grep finds files, not `file#symbol`, and scoring it on a symbol
// address it never claims to produce would rig the comparison. So every arm yields an ORDERED FILE LIST and the
// metric is where the declared anchor's file lands in it.
//
// THE GROUND TRUTH AND ITS BIAS, stated up front. `cases.json` carries a declared anchor per case, fixed before
// any of this existed. It is one defensible answer, not the only one: the judges pick a mechanism CLUSTER, and on
// keycloak they chose {Realms, refresh, loader} where the declared anchor is `RealmModel`. That is a different
// reading of the same question, not obviously a wrong one. So this reports WHAT EACH ARM PICKED alongside the
// rank, because a rank alone would launder that judgement call into a score.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = join(HERE, "..", "..");
const argv = process.argv.slice(2);
const TRIALS = Math.max(1, Number(argv.find((a) => a.startsWith("--trials="))?.split("=")[1] ?? 3));
const only = argv.filter((a) => !a.startsWith("--"));

type Case = { id: string; repo: string; task: string; anchor: string | null };
const cases: Case[] = JSON.parse(readFileSync(join(ROOT, "bench/grep-vs-seam/cases.json"), "utf-8")).cases
  .filter((c: Case) => c.anchor)                       // no declared anchor → nothing to score against
  .filter((c: Case) => !only.length || only.includes(c.id));
if (!cases.length) { console.error("no scorable case (need a declared `anchor` in cases.json)"); process.exit(2); }

const expand = (p: string) => p.replace(/^~/, homedir());
const norm = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "");

// ── the arms ─────────────────────────────────────────────────────────────────────────────────────────────────
// Each returns an ORDERED, DEDUPED file list (best first) plus what it would hand the caller as the anchor.
type Arm = { files: string[]; picked: string; secs: number };

// POSIX single-quote escaping. JSON.stringify LOOKS like quoting and is not: it emits DOUBLE quotes, inside
// which the shell still runs command substitution — and `cases.json` tasks contain backticks (`\`IntegrityReport\``),
// so the phrase reached the CLI empty and the locate arm scored 0 files on a case it actually answers at rank 2.
// A benchmark that silently passes an empty question to one arm is not measuring that arm.
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const sh = (cmd: string, cwd: string, timeoutMs = 900_000): string => {
  try { return execSync(cmd, { cwd, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }); }
  catch (e: any) { return e?.stdout ?? ""; }
};
const dedupe = (fs: string[]): string[] => [...new Set(fs.map(norm))];

// ARM 1 — `--locate-intent`: deterministic, offline, one call.
function armLocate(c: Case): Arm {
  const t0 = Date.now();
  const out = sh(`bun ${q(join(ROOT, "ts/src/cli/decompose.ts"))} --repo ${q(expand(c.repo))}`
    + ` --locate-intent ${q(c.task)}`, ROOT);
  const files = dedupe([...out.matchAll(/^- (\S+?)#/gm)].map((m) => m[1]));
  return { files, picked: files[0] ?? "(nothing)", secs: (Date.now() - t0) / 1000 };
}

// ARM 2 — the LLM judges. The centers cache is CLEARED first: reading it would score a frozen historical sample
// rather than what the judges do today, which is the exact mistake that motivated this harness.
function armJudges(c: Case): Arm {
  const repo = expand(c.repo);
  const cache = join(repo, ".seam", "centers-v1");
  const bak = `${cache}.benchbak`;
  if (existsSync(cache) && !existsSync(bak)) cpSync(cache, bak, { recursive: true });
  rmSync(cache, { recursive: true, force: true });
  const t0 = Date.now();
  const out = sh(`bun ${q(join(ROOT, "ts/src/cli/decompose.ts"))} --repo ${q(repo)}`
    + ` --scan --intent ${q(c.task)} --verbose 2>&1`, ROOT);
  const secs = (Date.now() - t0) / 1000;
  // The anchors it CHOSE (the `[center-first] N mechanism(s): …` line), then every file it went on to cite —
  // the chosen centers rank first because those are what it would hand a caller as `--center`.
  const picked = out.match(/\[center-first\][^\n]*mechanism\(s\): ([^\n]+)/)?.[1]?.trim() ?? "";
  const cited = [...out.matchAll(/\(([\w./@-]+\/[\w.@-]+\.\w{1,5}):\d+\)/g)].map((m) => m[1]);
  const chosen = picked ? cited.filter((f) => picked.split(",").some((s) => out.includes(`${s.trim()} (${f}`))) : [];
  return { files: dedupe([...chosen, ...cited]), picked: picked || "(nothing)", secs };
}

// ARM 3 — COMPETENT grep, the baseline that has to be able to win. Content words from the task, definition-shaped
// patterns first (a def is what an anchor IS), then plain occurrence; files ranked by how many DISTINCT task words
// they match, ties by definition-hits. This is what a careful agent does by hand, and it is given the same input.
const STOP = new Set(["the", "and", "how", "does", "what", "which", "from", "with", "that", "this", "would",
  "break", "changed", "used", "use", "its", "are", "was", "into", "over", "end", "side", "trace", "read", "reads",
  "update", "updates", "where", "defined", "signature", "participate", "modules", "hit", "database", "get", "gets"]);
function armGrep(c: Case): Arm {
  const repo = expand(c.repo);
  const t0 = Date.now();
  const words = [...new Set((c.task.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])
    .filter((w) => !STOP.has(w.toLowerCase())))].slice(0, 8);
  const hits = new Map<string, { words: Set<string>; defs: number }>();
  const bump = (f: string, w: string, isDef: boolean) => {
    const k = norm(f);
    if (!hits.has(k)) hits.set(k, { words: new Set(), defs: 0 });
    hits.get(k)!.words.add(w);
    if (isDef) hits.get(k)!.defs++;
  };
  for (const w of words) {
    // definition-shaped first — an anchor is a DEFINITION, so this is the search a competent agent runs
    for (const f of sh(`rg -l --no-messages -e ${q(`(class|interface|function|const|def|type|record|enum)\\s+\\w*${w}`)} -i . | head -40`, repo).split("\n").filter(Boolean))
      bump(f, w, true);
    for (const f of sh(`rg -l --no-messages -i ${q(w)} . | head -60`, repo).split("\n").filter(Boolean))
      bump(f, w, false);
  }
  const files = [...hits.entries()]
    .sort((a, b) => b[1].words.size - a[1].words.size || b[1].defs - a[1].defs || a[0].localeCompare(b[0]))
    .map(([f]) => f);
  return { files, picked: files[0] ?? "(nothing)", secs: (Date.now() - t0) / 1000 };
}

// ── score ────────────────────────────────────────────────────────────────────────────────────────────────────
// Rank of the declared anchor's FILE, 1-based; 0 = absent. Ranks are what matter here, not set overlap: an arm
// that returns the right file at position 400 has not helped anyone choose an anchor.
const rankOf = (files: string[], anchorFile: string): number => {
  const i = files.findIndex((f) => f === anchorFile || f.endsWith(`/${anchorFile}`) || anchorFile.endsWith(`/${f}`));
  return i < 0 ? 0 : i + 1;
};

type Row = { case: string; arm: string; rank: number; n: number; secs: number; picked: string };
const rows: Row[] = [];

for (const c of cases) {
  const repo = expand(c.repo);
  if (!existsSync(repo)) { console.error(`SKIP ${c.id}: ${repo} not present`); continue; }
  const anchorFile = norm(c.anchor!.split("#")[0]);
  process.stderr.write(`\n── ${c.id}  (anchor ${anchorFile})\n`);

  for (const [name, fn, trials] of [["locate", armLocate, 1], ["grep", armGrep, 1], ["judges", armJudges, TRIALS]] as const) {
    for (let t = 0; t < trials; t++) {
      const a = (fn as (c: Case) => Arm)(c);
      const rank = rankOf(a.files, anchorFile);
      rows.push({ case: c.id, arm: name, rank, n: a.files.length, secs: a.secs, picked: a.picked });
      process.stderr.write(`   ${name.padEnd(7)}${trials > 1 ? ` #${t + 1}` : "   "}  rank ${rank || "—"} of ${a.files.length}`
        + `  ${a.secs.toFixed(1)}s  → ${a.picked.slice(0, 70)}\n`);
    }
    // PUT THE CACHE BACK. `centers-v1` is gitignored working state a user's grows depend on; clearing it to
    // measure honestly is fine, leaving it cleared is vandalism by benchmark.
    if (name === "judges") {
      const cache = join(repo, ".seam", "centers-v1"), bak = `${cache}.benchbak`;
      if (existsSync(bak)) { rmSync(cache, { recursive: true, force: true }); cpSync(bak, cache, { recursive: true }); rmSync(bak, { recursive: true, force: true }); }
    }
  }
}

// A harness where an arm answered NOTHING everywhere is a broken arm, not a finding — the recurring failure in
// this project. Say so and exit non-zero rather than publish a table with a confident zero in it.
for (const arm of ["locate", "grep", "judges"]) {
  const mine = rows.filter((r) => r.arm === arm);
  if (mine.length && mine.every((r) => r.n === 0)) {
    console.error(`\nABORT: the ${arm} arm returned NO files on every case. That is a broken arm, not a result.`);
    process.exit(3);
  }
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (n: number, d: number) => (d ? ((n / d) * 100).toFixed(0) + "%" : "—");
console.log(`\n══════ ANCHOR SELECTION — ${cases.length} case(s), judges × ${TRIALS} trial(s)\n`);
console.log(`   arm      hit@1   hit@5   hit@25  found   median rank   median s`);
for (const arm of ["locate", "grep", "judges"]) {
  const mine = rows.filter((r) => r.arm === arm);
  if (!mine.length) continue;
  const found = mine.filter((r) => r.rank > 0);
  const med = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
  console.log(`   ${arm.padEnd(8)} ${pct(mine.filter((r) => r.rank === 1).length, mine.length).padStart(5)}`
    + `   ${pct(mine.filter((r) => r.rank >= 1 && r.rank <= 5).length, mine.length).padStart(5)}`
    + `   ${pct(mine.filter((r) => r.rank >= 1 && r.rank <= 25).length, mine.length).padStart(5)}`
    + `   ${pct(found.length, mine.length).padStart(5)}`
    + `   ${String(med(found.map((r) => r.rank)) || "—").padStart(11)}`
    + `   ${med(mine.map((r) => r.secs)).toFixed(1).padStart(8)}`);
}
console.log(`\n   hit@N = the declared anchor's FILE was in the arm's first N. "found" = anywhere in the list at all.`);
console.log(`   The declared anchor is ONE defensible answer, fixed before this harness existed — not the only one.`);
console.log(`   Read the per-case picks above before quoting the table: an arm can choose a different, sound anchor`);
console.log(`   and score zero here. That is a limit of the ground truth, not evidence the arm is wrong.`);

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", "anchor-select.json"), JSON.stringify({ trials: TRIALS, rows }, null, 2));
console.log(`\n   wrote ${join("bench/anchor-select/results", "anchor-select.json")}`);
