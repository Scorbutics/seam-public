// THE PROBE — one definition of ground truth, shared by every harness that needs it.
//
// Extracted from `sweep.ts` so that `compare.ts` cannot drift from it. A benchmark with two copies of its own
// truth definition is a benchmark that will eventually disagree with itself and blame the tool.
//
// THE METHOD. Prepend a required parameter to an exported function's declaration:
//
//     export function foo(a: string)  ->  export function foo(__oracleProbe: number, a: string)
//
// Every call site now fails to compile — wrong arity, and wrong type in the first position. So `tsc`'s fresh
// error set IS the complete call-site set. Prepending (not appending) so variadic and defaulted signatures work
// too: `...rest` must stay last, and an appended param after a default is legal but forces no error.
//
// EVERY COMMENT BELOW IS A FALSE ACCUSATION THIS HARNESS ONCE MADE. Read them before trusting a row.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

export const sh = (cmd: string, cwd: string, timeout = 900_000): string => {
  try { return execSync(cmd, { cwd, encoding: "utf-8", timeout, maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e: any) { return `${e.stdout ?? ""}${e.stderr ?? ""}`; }   // tsc exits non-zero WHEN IT FINDS ERRORS — the normal path
};

/// ONLY THE ARITY/TYPE ERROR AT THE CALL SITE COUNTS.
///
/// The first version counted every fresh error and immediately produced a FALSE ACCUSATION: it scored
/// `useSocialMediaVerification` as claimed-2-actual-4. There are exactly two calls; breaking each one ALSO
/// produced a downstream `TS7006 Parameter implicitly has an 'any' type` where the caller destructured the
/// now-untyped result. Two call sites, four errors.
///
/// TWO codes, and it took a second false accusation to learn why. Filtering to TS2554 alone then scored
/// `deriveMemberStatus` as claimed-3-actual-0 — Seam inventing three call sites. It had not: the function is
/// `(a, b, c?, d = …, e?)`, so it accepts 2..5 arguments and prepending a 6th REQUIRED parameter breaks no arity
/// at all. Each real call site instead reported TS2345 as its first argument slid onto the probe.
///
///   TS2554 — too few arguments (the callee had no optional tail)
///   TS2345 — the first argument no longer type-checks against the probe
/// Everything else is cascade downstream and is excluded.
export const CALL_SITE_ERROR = /error TS(2554|2345)$/;
export const fileOf = (e: string) => e.slice(0, e.indexOf("(")).replace(/^\.\//, "");

export type Probe = {
  /** Errors present before any mutation — truth is always a DIFF against this. */
  baseline: Set<string>;
  /** Paths `tsc` never compiles: a judge that cannot see the evidence must recuse itself, not rule. */
  excluded: string[];
  /** Exported functions, one per (file, name), restricted to what tsc actually compiles. */
  candidates: { file: string; name: string }[];
  /** Mutate, compile, restore. Returns the call sites tsc proves exist OUTSIDE the defining file. */
  truthFor(file: string, name: string): { sites: Set<string>; files: Set<string> } | null;
};

// DO NOT ADD A SIGNAL HANDLER HERE. It was tried, and it made things strictly worse.
//
// The restore lives in a `finally`, which covers every in-process failure but not a kill. The obvious fix — a
// `process.on("SIGTERM", restoreAll)` — was implemented and immediately produced an UNKILLABLE process: this
// harness spends essentially all of its wall clock inside a blocking `execSync` (one `tsc` compile per symbol),
// so the event loop never gets a turn and the callback never runs. Registering the listener only SUPPRESSED the
// default terminate behaviour. `kill -TERM` then did nothing at all, three times in a row, while the run
// carried on mutating files.
//
// So the honest position: the `finally` restores between symbols (a TERM'd run leaves at most ONE file probed,
// and only if it died mid-symbol), `SIGKILL` will leave that one file, and RECOVERY IS DOCUMENTED instead of
// pretended — `openProbe` refuses to start on a dirty repo and prints the exact `rg`/`git checkout` to run.
// A kill during a compile is recoverable in one command; a process that ignores your kill is not.
export function openProbe(repo: string, tsconfig: string): Probe {
  const errorsNow = (): Set<string> => {
    const out = sh(`node_modules/.bin/tsc --noEmit -p ${tsconfig}`, repo);
    const s = new Set<string>();
    for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): (error TS\d+)/gm)) s.add(`${m[1]}(${m[2]},${m[3]}): ${m[4]}`);
    return s;
  };

  // Recovery is spelled out because the most likely cause is a PREVIOUS run KILLED mid-mutation: the restore
  // lives in a `finally`, and SIGKILL does not run finally blocks. Ask before assuming it was you.
  if (sh("git status --porcelain", repo).split("\n").some((l) => l.trim() && !l.includes(".gitignore"))) {
    console.error("ABORT: repo has uncommitted changes beyond .gitignore — refusing to mutate.");
    console.error(`  If a previous run was interrupted, a probe may be left behind. Recover with:`);
    console.error(`    cd ${repo} && rg -l __oracleProbe -g '!node_modules' . && git checkout -- <those files>`);
    process.exit(2);
  }

  process.stderr.write("baseline compile…\n");
  const baseline = errorsNow();
  process.stderr.write(`baseline: ${baseline.size} pre-existing error(s)\n`);

  // `tsc --showConfig` and NOT a hand-parse of tsconfig.json: stripping comments with a regex corrupted the
  // JSON, the catch swallowed it, and the filter silently matched nothing — which is how one attempt reported
  // "908 of 908 inside tsc's program" and changed no result. --showConfig resolves `extends` and cannot drift.
  const excluded: string[] = (() => {
    const out = sh(`node_modules/.bin/tsc -p ${tsconfig} --showConfig`, repo, 120_000);
    try { return (JSON.parse(out).exclude ?? []).filter((x: string) => !x.includes("*")); }
    catch { console.error("WARNING: could not read tsc --showConfig; excluded-path candidates will NOT be skipped"); return []; }
  })();
  if (excluded.length) process.stderr.write(`tsconfig excludes ${excluded.join(", ")} — candidates there are SKIPPED (the oracle is blind to them)\n`);

  // `--sort path`, and it is not cosmetic. rg's default parallel traversal returns files in whatever order the
  // threads finish, so a run with a `limit` sampled a DIFFERENT subset every time — two runs of `limit 12` on an
  // unchanged repo scored twelve overlapping-but-different symbols, which makes a limited run impossible to
  // compare against itself or against a previous result. Sorting costs one lost thread on a scan that takes
  // milliseconds and makes the sample reproducible.
  const decl = sh(`rg -n --no-heading --sort path '^export (async )?function [A-Za-z_$][A-Za-z0-9_$]*\\(' -g '*.ts' -g '*.tsx' -g '!node_modules' . || true`, repo);
  const all: { file: string; name: string }[] = [];
  for (const line of decl.split("\n").filter(Boolean)) {
    const m = /^(.+?):\d+:export (?:async )?function ([A-Za-z_$][A-Za-z0-9_$]*)\(/.exec(line);
    if (m) all.push({ file: m[1].replace(/^\.\//, ""), name: m[2] });
  }
  const candidates = all.filter((c) => !excluded.some((x) => c.file === x || c.file.startsWith(`${x}/`)));
  process.stderr.write(`${all.length} exported function(s) found, ${candidates.length} inside tsc's program\n`);

  return {
    baseline,
    excluded,
    candidates,
    truthFor(file: string, name: string) {
      const abs = join(repo, file);
      const original = readFileSync(abs, "utf-8");
      const re = new RegExp(`(export (?:async )?function ${name})\\(`);
      if (!re.test(original)) return null;
      try {
        writeFileSync(abs, original.replace(re, `$1(__oracleProbe: number, `));
        const fresh = [...errorsNow()].filter((e) => !baseline.has(e));
        const external = fresh.filter((e) => fileOf(e) !== file && CALL_SITE_ERROR.test(e));
        // Dedupe by FULL POSITION — file, line AND COLUMN. Dropping the column to collapse "one site, two
        // codes" also collapsed TWO CALLS ON ONE LINE: `expect(rank("a", 28)).toBeLessThan(rank("b", 28))` is
        // two call sites on one line, and there were 16 across 9 lines, scored as a +7 over-claim. TS2554 and
        // TS2345 are mutually exclusive at a position, so keeping the column costs nothing.
        return {
          sites: new Set(external.map((e) => e.replace(/: error TS\d+$/, ""))),
          files: new Set(external.map(fileOf)),
        };
      } finally {
        writeFileSync(abs, original);   // ALWAYS restore, even on throw
      }
    },
  };
}
