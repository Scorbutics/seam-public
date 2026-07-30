// THE ORACLE HARNESS — measure structural correctness against a JUDGE THAT CANNOT BE ARGUED WITH.
//
// WHY THIS EXISTS, separately from bench/grep-vs-seam:
//
// The flow benchmark answers "does this help an agent?" — a property of tool + model + question. It is
// expensive (two subagents per case), n=1 per cell, and dominated by agent variance: grep scored 81/81 on the
// private-app case in run 1 and 46/81 in run 2, on the IDENTICAL question. Reading engine correctness off that
// instrument was the methodological error behind three runs of noisy conclusions.
//
// This harness answers the OTHER question — "is the engine structurally correct and honest?" — which is a
// property of the tool alone. No LLM, no subagent, no judgement: `tsc` decides. It is cheap enough to run on
// every change, and its n is the number of call sites in the repo rather than the number of cases we can afford.
//
// THE METHOD. Take a real, breaking edit (narrow a variadic signature to fixed arity). Ask each tool to predict
// what breaks. THEN APPLY THE EDIT AND RUN `tsc`. The compiler's error list is ground truth — complete by
// construction, and independent of both tools.
//
// Errors are DIFFED against a baseline: the repo already has 23 pre-existing errors (unrelated Deno/stripe
// typings), so "errors after" alone would be wrong. Truth = after - before.
//
// WHAT IS SCORED, and at which grain:
//   FILE RECALL   — every file `tsc` flags must appear in the tool's consumer set. A flagged file the tool never
//                   listed is a MISS; if the tool also did not declare a blindspot covering it, it is a SILENT
//                   miss, which is the expensive kind and the metric this whole exercise exists to measure.
//   COUNT ACCURACY— the tool's predicted number of breaking sites vs the actual error count.
// Set comparison is at FILE grain because that is the finest grain BOTH tools can express: `--query contract`
// reports an arity histogram (counts, not locations), so Seam can predict HOW MANY sites break but cannot name
// WHICH. That is a real product gap and this harness is what makes it visible — see README.
//
// SAFETY. The target file is restored in a `finally`, and the run aborts if the repo is dirty in a way that
// would make a restore ambiguous. Never leaves a mutation behind.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";

type Mutation = { find: string; replace: string };
type Case = {
  id: string;
  repo: string;
  file: string;          // the file holding the symbol, repo-relative
  symbol: string;
  tsconfig: string;
  mutation: Mutation;
  /** arity the mutated signature accepts — a call site outside this range is expected to break */
  acceptsArgc: number[];
};

const HERE = dirname(new URL(import.meta.url).pathname);
const sh = (cmd: string, cwd: string, timeout = 900_000): string => {
  try { return execSync(cmd, { cwd, encoding: "utf-8", timeout, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e: any) { return `${e.stdout ?? ""}${e.stderr ?? ""}`; }   // tsc exits non-zero WHEN IT FINDS ERRORS — that is the normal path
};

/** `path(line,col): error TSxxxx: msg` → a stable key. */
const parseErrors = (out: string): Set<string> => {
  const set = new Set<string>();
  for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): (error TS\d+): (.*)$/gm)) set.add(`${m[1]}(${m[2]},${m[3]}): ${m[4]}: ${m[5]}`);
  return set;
};
const fileOf = (err: string): string => err.slice(0, err.indexOf("("));

const tscErrors = (c: Case): Set<string> =>
  parseErrors(sh(`node_modules/.bin/tsc --noEmit -p ${c.tsconfig}`, c.repo));

// ── the tools under test ────────────────────────────────────────────────────────────────────────────────────
const SEAM = "cd /home/scorbutics/seam-phase0/ts && bun src/cli/decompose.ts";

/** Seam's answer: the consuming FILE set, plus the predicted breaking-site count from the arity histogram. */
function seamPredict(c: Case): { files: Set<string>; predicted: number | null; declaredGaps: string[] } {
  const out = sh(`${SEAM} --scan --repo ${c.repo} --query contract --center ${c.file} --format llm-context`, "/", 900_000);
  const files = new Set<string>();
  for (const m of out.matchAll(/^\s+← \S+ \((.+?)\)$/gm)) files.add(m[1]);

  // `observed: N call sites — 9×1arg, 253×2arg, …`  → sites whose argc the mutated signature will not accept
  let predicted: number | null = null;
  const hist = /observed: \d+ call sites? — (.+)$/m.exec(out);
  if (hist) {
    predicted = 0;
    for (const b of hist[1].matchAll(/(\d+)×(\d+)arg/g)) {
      const [n, argc] = [Number(b[1]), Number(b[2])];
      if (!c.acceptsArgc.includes(argc)) predicted += n;
    }
  }
  const declaredGaps = [...out.matchAll(/^- (\S+) — /gm)].map((m) => m[1]);
  return { files, predicted, declaredGaps };
}

/** The grep baseline: files that textually call the symbol. */
function grepPredict(c: Case): { files: Set<string>; predicted: number | null } {
  const out = sh(`rg -c '\\b${c.symbol}\\(' -g '!node_modules' -g '*.ts' -g '*.tsx' . || true`, c.repo);
  const files = new Set<string>();
  let total = 0;
  for (const line of out.split("\n").filter(Boolean)) {
    const i = line.lastIndexOf(":");
    if (i < 0) continue;
    const f = line.slice(0, i).replace(/^\.\//, "");
    const n = Number(line.slice(i + 1));
    if (f === c.file) continue;                 // the definition's own file
    files.add(f);
    total += n;
  }
  // grep can count call sites but has NO WAY to know which break — arity is not a textual property. `null` is
  // the honest answer, and scoring it as a miss rather than as 0 would be scoring a claim it never made.
  return { files, predicted: null };
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────
const cases: Case[] = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf-8"));
const only = process.argv[2];

for (const c of cases.filter((x) => !only || x.id === only)) {
  const abs = join(c.repo, c.file);
  const dirty = sh("git status --porcelain", c.repo).split("\n").filter(Boolean);
  if (dirty.some((l) => l.includes(c.file))) {
    console.error(`ABORT ${c.id}: ${c.file} is already modified — cannot restore cleanly`);
    continue;
  }
  const original = readFileSync(abs, "utf-8");
  if (!original.includes(c.mutation.find)) {
    console.error(`ABORT ${c.id}: the mutation target is not present in ${c.file} (the source moved — update cases.json)`);
    continue;
  }

  let result: any;
  try {
    process.stderr.write(`[${c.id}] asking the tools…\n`);
    const seam = seamPredict(c);
    const grep = grepPredict(c);

    process.stderr.write(`[${c.id}] tsc baseline…\n`);
    const before = tscErrors(c);

    process.stderr.write(`[${c.id}] mutating + tsc…\n`);
    writeFileSync(abs, original.replace(c.mutation.find, c.mutation.replace));
    const after = tscErrors(c);

    // TRUTH = what the edit newly broke.
    const truth = [...after].filter((e) => !before.has(e));
    const truthFiles = new Set(truth.map(fileOf).map((f) => f.replace(/^\.\//, "")));
    truthFiles.delete(c.file);   // the definition's own file is not a consumer

    const score = (label: string, files: Set<string>, predicted: number | null, gaps: string[] = []) => {
      const missed = [...truthFiles].filter((f) => !files.has(f));
      return {
        label,
        listedFiles: files.size,
        truthFiles: truthFiles.size,
        recall: truthFiles.size ? +(((truthFiles.size - missed.length) / truthFiles.size) * 100).toFixed(1) : 100,
        missed,
        silentMissed: gaps.length ? missed.length : missed.length,   // gaps are file-agnostic today; see README
        predictedSites: predicted,
        actualSites: truth.length,
        countError: predicted === null ? null : predicted - truth.length,
      };
    };
    result = { case: c.id, seam: score("SEAM", seam.files, seam.predicted, seam.declaredGaps), grep: score("GREP", grep.files, grep.predicted) };
  } finally {
    writeFileSync(abs, original);   // ALWAYS restore, even on throw
  }

  const stillDirty = sh("git status --porcelain", c.repo).split("\n").filter((l) => l.includes(c.file));
  if (stillDirty.length) console.error(`WARNING ${c.id}: ${c.file} still differs after restore — check manually`);

  mkdirSync(join(HERE, "results"), { recursive: true });
  writeFileSync(join(HERE, "results", `${c.id}.json`), JSON.stringify(result, null, 2));

  console.log(`\n══ ${c.id}`);
  console.log(`   tsc says: ${result.seam.actualSites} newly-broken site(s) across ${result.seam.truthFiles} file(s)`);
  for (const r of [result.seam, result.grep]) {
    console.log(`\n── ARM ${r.label}`);
    console.log(`   files listed      ${r.listedFiles}`);
    console.log(`   FILE RECALL       ${r.recall}%  (missed ${r.missed.length})`);
    if (r.missed.length) console.log(`   missed            ${r.missed.slice(0, 5).join(", ")}${r.missed.length > 5 ? " …" : ""}`);
    console.log(`   predicted sites   ${r.predictedSites ?? "— (cannot express)"}${r.countError !== null ? `   (off by ${r.countError})` : ""}`);
  }
}
