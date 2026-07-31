// VERIFICATION TAX — why an agent keeps working AFTER Seam has answered.
//
// `bun bench/grep-vs-seam/verification-tax.ts <case-id> [repo]`
//
// THE QUESTION. Every run of this benchmark ends the same way: Seam answers, the agent uses the answer, and then
// the agent goes and checks the code anyway. Run 2's arm said so in its own words — the call-site histogram was
// "reproduced exactly by an independent string-aware scan". That post-answer work is the tax, and it is the
// difference between a tool an agent CONSULTS and a tool an agent TRUSTS.
//
// "The agent checked the code itself" is a SYMPTOM WITH THREE DISEASES, and they have opposite cures:
//
//   CONTENT gap — Seam cited the file but did not ship enough of it to decide. Cure: better snippets. This is
//                 the cheap one, and the one we would rather it were.
//   RECALL  gap — Seam never cited the file at all. Cure: find more. Snippets cannot help; a wider window on a
//                 result set that does not contain the answer is wasted output.
//   TRUST   gap — Seam cited it AND shipped the content AND the agent looked anyway. Cure: nothing in the
//                 renderer. This is grep-trained distrust and run 2 proved richer output does not remove it.
//
// Guessing which one dominates is how three plausible fixes in this project changed nothing. So this measures.
//
// THE METHOD, and the reason it is possible at all: the stored `.trace` records the EXACT seam invocations, and
// the engine is offline and deterministic. So we re-run them, capture what Seam actually PRINTED, and classify
// every later shell command against that citation set. The classification is mechanical and every command is
// printed with its verdict, because a bin count nobody can audit is a number to distrust.
//
// WHAT IT IS NOT. The bins are heuristic — a command is matched to a file by path, and a repo-wide `rg` with no
// path is judged by whether it searches the ANCHOR symbol (re-deriving the answer) or a new one (expanding the
// question). Read the per-command dump, not just the totals.
import { execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const [caseId, repoArg] = process.argv.slice(2);
if (!caseId) { console.error("usage: verification-tax.ts <case-id> [repo]"); process.exit(2); }
const HERE = dirname(new URL(import.meta.url).pathname);
const TRACE = join(HERE, "results", `${caseId}.B.trace`);
if (!existsSync(TRACE)) { console.error(`ABORT: no seam-arm trace at ${TRACE}`); process.exit(2); }

const cmds = readFileSync(TRACE, "utf-8").split("\n")
  .filter((l) => l.startsWith("$ ")).map((l) => l.slice(2).trim());

// ── replay the seam invocations to recover what the agent was actually shown ──────────────────────────────────
const isSeam = (c: string) => /decompose\.ts|(^|\s)seam\s/.test(c) && !/--help/.test(c);
const seamCmds = cmds.filter(isSeam);
if (!seamCmds.length) { console.error("ABORT: the trace contains no seam invocation. Not a case."); process.exit(3); }

const TS = join(HERE, "..", "..", "ts");
const CACHE = join(HERE, "results", `${caseId}.B.shown`);   // the replay is minutes of cold scan; keep it
let shown = existsSync(CACHE) ? readFileSync(CACHE, "utf-8") : "";
for (const c of shown ? [] : seamCmds) {
  // the traces are written from ts/ or from the target repo; re-run from ts/ where the CLI lives
  // STRIP THE REDIRECTIONS, or the replay silently captures nothing. The cal.com arm wrote every seam answer
  // to `> /tmp/seam_grow_handler.txt 2>/tmp/...err` and read it back later; replaying that verbatim sent the
  // output to a file and left `shown` almost empty — which would have scored as "Seam cited 124 files and
  // printed content for 4". A replay that loses the output is not a measurement of a thin output.
  const cmd = c.replace(/^cd\s+\S+\s*&&\s*/, "")
               .replace(/\s*\d?>>?\s*\S+/g, "")                                   // > file, 2> file, >> file
               .replace(/\s*\|\s*(head|tail|wc|rg|grep|sed|cut|sort)\b.*$/, "");  // and the display pipes
  try { shown += execSync(cmd, { cwd: TS, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 900_000 }); }
  catch (e: any) { shown += e?.stdout ?? ""; }
}
// A REPLAY THAT PRINTS NOTHING IS NOT A FINDING OF "no citations" — it is a broken replay, and this project has
// shipped that exact failure four times (a gate with no case, a vacuous decoy, `EXACT 0/0`, an installer whose
// health check discarded its own result). Refuse to score it.
if (shown.trim().length < 200) {
  console.error(`ABORT: replaying ${seamCmds.length} seam command(s) produced ${shown.length} chars of output.`);
  console.error("The replay is broken, or the repo moved. This is NOT evidence that Seam cited nothing.");
  process.exit(3);
}
if (!existsSync(CACHE)) writeFileSync(CACHE, shown);

// ── what Seam cited, and what it SHOWED ──────────────────────────────────────────────────────────────────────
// cited  = a path appeared anywhere in the output
// shownL = a (file, line) whose CONTENT was printed as a snippet — the `264>` / `263│` gutter lines
const cited = new Set<string>();
const snippetFiles = new Set<string>();
const base = (p: string) => p.split("/").pop()!;
for (const m of shown.matchAll(/([\w./@-]+\/[\w.@-]+\.\w{1,5})(?::(\d+))?/g)) cited.add(m[1]);
{
  // a snippet block belongs to the citation on the nearest preceding edge line
  let current = "";
  for (const line of shown.split("\n")) {
    const edge = line.match(/\(([\w./@-]+\.\w{1,5}):(\d+)\)/);
    if (edge) { current = edge[1]; continue; }
    if (/^\s+\d+[│>]/.test(line) && current) snippetFiles.add(current);
  }
}
if (!cited.size) { console.error("ABORT: parsed 0 citations out of a non-empty replay — the extractor is broken."); process.exit(3); }

// the anchor symbol: whatever the seam commands centred on
const anchorSym = seamCmds.map((c) => c.match(/#(\w+)|--symbol\s+(\S+)/)).find(Boolean);
const ANCHOR = anchorSym ? (anchorSym[1] ?? anchorSym[2]) : "";

// ── classify every command issued AFTER the first seam answer ────────────────────────────────────────────────
const firstSeam = cmds.findIndex(isSeam);
const after = cmds.slice(firstSeam + 1).filter((c) => !isSeam(c));

type Bin = "CONTENT" | "RECALL" | "TRUST" | "EXPAND" | "PLUMBING";
const rows: { cmd: string; bin: Bin; why: string }[] = [];

// STRIP QUOTED SEGMENTS BEFORE LOOKING FOR A FILE TARGET. The first version did not, and every one of its
// mistakes came from that: `rg -v 'lib/utils.ts'` (a path being EXCLUDED) read as a file access, and
// `rg -o "sidebar.tsx:([0-9]+)" /tmp/cn_consumers.txt` (a regex over Seam's own saved output) read as
// re-opening sidebar.tsx. A path inside a pattern is a string, not a file the agent opened.
const unquoted = (c: string) => c.replace(/'[^']*'|"[^"]*"/g, " ");

for (const c of after) {
  // HARNESS PLUMBING, not analysis: writing the answer/trace artifacts, or listing the results dir. `cp
  // /tmp/private-app-cn-consumers.B.md results/` was binned TRUST by the first version because the FILENAME contains
  // `cn` — the benchmark's own bookkeeping charged to the tool under test.
  if (/bench\/grep-vs-seam|\.B\.(md|trace)|\.A\.(md|trace)/.test(c)) {
    rows.push({ cmd: c, bin: "PLUMBING", why: "benchmark bookkeeping, not a code access" });
    continue;
  }
  // shuffling Seam's own saved output around is not re-reading the CODE, whatever tool does the shuffling
  if (/\/tmp\//.test(c) && !/\/tmp\/\S*\.(tsx?|jsx?|java|rb|py)\b/.test(unquoted(c).replace(/\/tmp\/\S+/g, (m) => m))) {
    const readsRepo = /(^|\s)(cat|rg|grep|sed|head|tail)\s+[^|]*\s(?!\/tmp)[\w./@-]+\.(tsx?|jsx?|java|rb|py)\b/.test(unquoted(c));
    if (!readsRepo) { rows.push({ cmd: c, bin: "PLUMBING", why: "operates on Seam's saved output, not on source" }); continue; }
  }
  // does it name a concrete source file, OUTSIDE any quoted pattern?
  const paths = [...unquoted(c).matchAll(/([\w./@-]*[\w@-]+\.(?:tsx?|jsx?|mjs|java|rb|py|c|cc|cpp|h|hpp))\b/g)]
    .map((m) => m[1]).filter((p) => !p.startsWith("/tmp"));
  const target = paths[0];   // the file the command reads; a command naming several is binned by the first
  if (target) {
    const isCited = cited.has(target) || [...cited].some((k) => base(k) === base(target));
    const wasShown = [...snippetFiles].some((k) => base(k) === base(target));
    if (isCited && wasShown) rows.push({ cmd: c, bin: "TRUST", why: `Seam cited ${base(target)} AND printed its lines` });
    else if (isCited) rows.push({ cmd: c, bin: "CONTENT", why: `Seam cited ${base(target)} but shipped no snippet for it` });
    else rows.push({ cmd: c, bin: "RECALL", why: `${base(target)} never appeared in Seam's output` });
    continue;
  }
  // repo-wide search: re-deriving the answer, or asking a new question?
  if (/\b(rg|grep|ag|find)\b/.test(c)) {
    // Test the anchor against the command with BACKSLASHES BLANKED. `rg -c "\bcn\("` does not match `\bcn\b`:
    // the character before `cn` is the literal `b` of the `\b` escape, so there is no word boundary. That one
    // detail mis-binned repo-wide re-derivations of the anchor as EXPAND — i.e. it under-reported the tax.
    const reDerives = ANCHOR && new RegExp(`\\b${ANCHOR}\\b`).test(c.replace(/\\/g, " "));
    rows.push(reDerives
      ? { cmd: c, bin: "TRUST", why: `repo-wide search for the anchor symbol '${ANCHOR}' Seam already enumerated` }
      : { cmd: c, bin: "EXPAND", why: "repo-wide search for something other than the anchor" });
    continue;
  }
  rows.push({ cmd: c, bin: "PLUMBING", why: "not a source access" });
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────────────────
const tally = { CONTENT: 0, RECALL: 0, TRUST: 0, EXPAND: 0, PLUMBING: 0 } as Record<Bin, number>;
for (const r of rows) tally[r.bin]++;

console.log(`\n══════ VERIFICATION TAX — ${caseId}`);
console.log(`   ${seamCmds.length} seam invocation(s) replayed -> ${cited.size} file(s) cited, ${snippetFiles.size} with printed lines`);
console.log(`   anchor symbol: ${ANCHOR || "(none parsed)"}`);
console.log(`   ${after.length} non-seam command(s) issued after the first answer\n`);

for (const r of rows) console.log(`   ${r.bin.padEnd(9)} ${r.cmd.slice(0, 96)}\n             └─ ${r.why}`);

const taxed = tally.CONTENT + tally.RECALL + tally.TRUST;
console.log(`\n   ── bins`);
for (const k of ["CONTENT", "RECALL", "TRUST", "EXPAND", "PLUMBING"] as Bin[])
  console.log(`   ${k.padEnd(9)} ${String(tally[k]).padStart(3)}${taxed && k !== "EXPAND" && k !== "PLUMBING" ? `   (${((tally[k] / taxed) * 100).toFixed(0)}% of the tax)` : ""}`);
console.log(`\n   THE TAX = CONTENT + RECALL + TRUST = ${taxed} of ${after.length} post-answer commands.`);
console.log(`   CONTENT is fixable by the renderer. RECALL is fixable by the engine. TRUST is fixable by neither.`);
console.log(`\n   Classification is heuristic — read the per-command dump above before quoting the bins.`);
