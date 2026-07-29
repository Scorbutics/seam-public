// DIFFERENTIAL: Rust `seam_grow::center_repo` vs the TypeScript oracle (`detectCentersRepoWide`).
//
// Both compared sets are CAPTURED THROUGH THE JUDGES rather than from extracted helpers — `sourceDirs` and
// the recall are internal to the TypeScript, and lifting them out first would mean comparing against code
// written for this harness instead of the code that runs. The judges are exactly where the two sets leave
// the function, so a capturing judge sees what the LLM would have seen.
//
//   STAGE-1 INPUT  the source-directory listing (dir + sample basenames)
//   STAGE-2 INPUT  the bounded candidate set, in BOTH modes:
//                    scoped  — dirJudge picked a domain dir: no whole-repo def cap, mechanism-level only,
//                              ranked type-first then fan-in
//                    floor   — no dirJudge: the offline lexical net over the capped whole repo
//
// The dir judge's "pick" is deterministic (first / first-two / a deep one) so a failure reproduces.
//
//   SEAM_GRAPH_CACHE=0 bun rust/parity/center_repo.ts
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCentersRepoWide } from "../../ts/src/codebase/grow/center_repo.js";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";

process.env.SEAM_GRAPH_CACHE = "0";   // the LLM path caches its pick; a frozen cluster would skip the recall
const addon: any = loadAddon();
if (!addon) { console.log("no addon"); process.exit(0); }

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..", "..");
const fixtures = join(REPO, "ts", "test", "fixtures");

const repos = [
  ...readdirSync(fixtures).filter((d) => d.endsWith("-repo")).map((d) => join(fixtures, d)),
  join(fixtures, "booking-app"),
  join(REPO, "ts"),        // a real, large, multi-language-free tree — the only corpus member with depth
].filter((p) => existsSync(p));

const INTENTS = [
  "how does a booking get confirmed?",
  "where are payments captured",
  "user authentication and session handling",
  "zzz nothing matches this intent at all",   // the empty-recall path
  // MEASURED corpus gap: with only the intents above, changing the lexical floor's name-vs-path weight from
  // 3 to 1 reordered NOTHING — every candidate hit on its name or not at all, so the relative weight never
  // decided a comparison. These two are term-rich enough that path-only scores reach 4 and 100 defs hit on
  // BOTH a name and a path, which is what makes the weight observable (probed: 2/10 pairs reorder).
  "codebase grow render seams intent ranking",
  "booking payment confirm notify email service repository controller",
];

let okDirs = 0, badDirs = 0, okCands = 0, badCands = 0, okCenters = 0, badCenters = 0;
let scopedRuns = 0, floorRuns = 0, emptyRecall = 0, nonEmptyRecall = 0, dirRows = 0;
const fails: string[] = [];
const push = (m: string) => { if (fails.length < 6) fails.push(m); };

for (const repo of repos) {
  for (const includeTests of [false, true]) {
    for (const exclude of [[] as string[], ["test"], ["src"]]) {
      // ---- STAGE 1: the dir listing ------------------------------------------------------------------------
      let capturedDirs: { dir: string; sample: string[] }[] | null = null;
      const dirJudge = async (_i: string, dirs: any[]) => { capturedDirs = dirs; return null; };

      for (const intent of INTENTS) {
        for (const mode of ["scoped", "floor"] as const) {
          for (const cap of [10, 60]) {
            let capturedCands: any[] | null = null;
            let pickedDirs: string[] | null = null;
            const judge = async (_i: string, cands: any[]) => { capturedCands = cands; return null; };
            // deterministic stand-in for the LLM's directory pick: the FIRST and the DEEPEST source dir, so
            // both a shallow and a nested scope are exercised
            const scopingJudge = async (i: string, dirs: any[]) => {
              capturedDirs = dirs;
              if (!dirs.length) return null;
              const deep = [...dirs].sort((a, b) => b.dir.split("/").length - a.dir.split("/").length)[0];
              pickedDirs = [...new Set([dirs[0].dir, deep.dir])];
              return pickedDirs;
            };

            const tsCenters = await detectCentersRepoWide(repo, intent, {
              k: 4, cap, excludeDirs: exclude, includeTests,
              dirJudge: mode === "scoped" ? scopingJudge : dirJudge,
              judge,
            });

            if (mode === "scoped") scopedRuns++; else floorRuns++;

            // ---- compare the dir listing --------------------------------------------------------------------
            const rsDirs = JSON.parse(addon.growSourceDirs(repo, exclude, includeTests));
            dirRows += rsDirs.length;
            const nd = (xs: any[]) => JSON.stringify((xs ?? []).map((d) => [d.dir, d.sample]));
            if (nd(capturedDirs ?? []) === nd(rsDirs)) okDirs++;
            else { badDirs++; push(`sourceDirs ${repo.split("/").pop()} ex=${exclude} tests=${includeTests}\n  TS n=${(capturedDirs ?? []).length} RS n=${rsDirs.length}\n  TS: ${nd(capturedDirs ?? []).slice(0, 260)}\n  RS: ${nd(rsDirs).slice(0, 260)}`); }

            // ---- compare the candidate set ------------------------------------------------------------------
            const rsCands = JSON.parse(addon.growCenterCandidates(
              repo, intent, mode === "scoped" ? (pickedDirs ?? undefined) : undefined, exclude, includeTests, cap));
            const nc = (xs: any[]) => JSON.stringify((xs ?? []).map((c) => [c.symbol, c.file, c.kind, c.signature, c.fanIn]));
            if ((capturedCands ?? []).length) nonEmptyRecall++; else emptyRecall++;
            if (nc(capturedCands ?? []) === nc(rsCands)) okCands++;
            else { badCands++; push(`candidates ${repo.split("/").pop()} ${mode} intent="${intent.slice(0, 24)}" cap=${cap} ex=${exclude} tests=${includeTests}\n  TS n=${(capturedCands ?? []).length} RS n=${rsCands.length}\n  TS: ${nc(capturedCands ?? []).slice(0, 260)}\n  RS: ${nc(rsCands).slice(0, 260)}`); }

            // ---- and the CENTERS the whole function returns (judge declined → top-k of the recall) ----------
            const rsCenters = rsCands.slice(0, 4).map((c: any) => ({ id: `${c.file}#${c.symbol}`, file: c.file, symbol: c.symbol, fanIn: c.fanIn }));
            if (JSON.stringify(tsCenters) === JSON.stringify(rsCenters)) okCenters++;
            else { badCenters++; push(`centers ${repo.split("/").pop()} ${mode}\n  TS: ${JSON.stringify(tsCenters).slice(0, 220)}\n  RS: ${JSON.stringify(rsCenters).slice(0, 220)}`); }
          }
        }
      }
    }
  }
}

console.log(`center-repo parity: dirs ${okDirs} ok / ${badDirs} bad, candidates ${okCands} ok / ${badCands} bad, centers ${okCenters} ok / ${badCenters} bad`);
console.log(`  (repos ${repos.length}, scoped runs ${scopedRuns}, floor runs ${floorRuns}, non-empty recall ${nonEmptyRecall}, empty ${emptyRecall}, dir rows compared ${dirRows})`);
for (const x of fails) console.log("  " + x);
if (badDirs || badCands || badCenters) process.exit(1);
