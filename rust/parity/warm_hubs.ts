// DIFFERENTIAL: Rust `seam_grow::warm::rank_hubs` vs the TypeScript oracle (`rankHubs`).
//
// The ranking is what decides which files `seam --warm` pre-grows, and the list is CUT to `top` — so an
// ordering difference is not cosmetic, it changes which subsystems come out warm and which still pay the
// full cold cost (measured on cal.com: 140.9s cold vs 6.8s warm).
//
// The tie order is the thing under test. Fan-in counts collide constantly (a repo has many files imported
// exactly once), the sort is stable, and the cut lands mid-plateau — so equal-fan-in files are separated
// only by the reverse-import map's insertion order. That is why the Rust map had to become an IndexMap:
// a HashMap would have leaked Rust's hash order into the warm set. `top` is swept across small values to
// put the cut INSIDE a tie plateau rather than past it.
//
//   bun rust/parity/warm_hubs.ts
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rankHubs } from "../../ts/src/codebase/grow/warm.js";
import { fileImporters } from "../../ts/src/core/resolve/consumers.js";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const addon: any = loadAddon();
if (!addon) { console.log("no addon"); process.exit(0); }

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..", "..");
const fixtures = join(REPO, "ts", "test", "fixtures");
const repos = [
  ...readdirSync(fixtures).filter((d) => d.endsWith("-repo")).map((d) => join(fixtures, d)),
  join(fixtures, "booking-app"),
  join(REPO, "ts"),      // the only corpus member deep enough to have real fan-in plateaus
].filter((p) => existsSync(p));

// MEASURED gap: of the warm regex's four alternatives, only `tests?/` is reachable through the fixtures —
// no fixture has a `__mocks__`, `__tests__` or `*.test.ts` file that is an IMPORT TARGET, so a mutation
// deleting `__mocks__` from the pattern changed nothing. Mocks especially: they are imported BY tests, and
// usually auto-resolved rather than imported, so they never appear as a target in a natural repo.
// Synthesised here rather than added to ts/test/fixtures, which the CLI snapshot gate hashes.
const synth = join(tmpdir(), "seam-warm-parity-" + process.pid);
{
  const w = (rel: string, t: string) => { const p = join(synth, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
  w("package.json", `{"name":"warm-synth","version":"1.0.0"}\n`);
  // each of these is a TARGET: imported by two ordinary source files, so it earns real fan-in and would
  // rank into the warm set if the convention did not drop it
  for (const [rel, sym] of [
    ["src/__mocks__/db.ts", "mockDb"], ["src/__tests__/helpers.ts", "helper"],
    ["src/thing.test.ts", "fromTest"], ["tests/support.ts", "support"],
    ["src/real/hub.ts", "hub"],
  ] as [string, string][]) w(rel, `export function ${sym}(x: number) { return x; }\n`);
  for (const i of [0, 1]) w(`src/app/consumer${i}.ts`,
    [`import { mockDb } from "../__mocks__/db";`, `import { helper } from "../__tests__/helpers";`,
     `import { fromTest } from "../thing.test";`, `import { support } from "../../tests/support";`,
     `import { hub } from "../real/hub";`,
     `export const use${i} = () => [mockDb(1), helper(1), fromTest(1), support(1), hub(1)];`].join("\n") + "\n");
}
repos.push(synth);

let ok = 0, bad = 0, compared = 0, nonEmpty = 0, cutInTie = 0, totalHubs = 0, maxFan = 0;
const fails: string[] = [];

for (const repo of repos) {
  const importers = await fileImporters(repo);
  for (const includeTests of [false, true]) {
    for (const excludeDirs of [[] as string[], ["src"], ["test", "node_modules"]]) {
      for (const top of [1, 2, 3, 5, 40, 1000]) {
        const ts = rankHubs(importers, top, includeTests, excludeDirs);
        const rs = JSON.parse(addon.growRankHubs(repo, top, includeTests, excludeDirs));
        compared++;
        totalHubs += ts.length;
        if (ts.length) nonEmpty++;
        if (ts.length) maxFan = Math.max(maxFan, ts[0].fanIn);
        // did the cut land INSIDE a run of equal fan-in? that is where insertion order alone decides
        const all = rankHubs(importers, 1e9, includeTests, excludeDirs);
        if (ts.length && all.length > ts.length && all[ts.length].fanIn === ts[ts.length - 1].fanIn) cutInTie++;

        const n = (xs: any[]) => JSON.stringify(xs.map((h) => [h.file, h.fanIn]));
        if (n(ts) === n(rs)) ok++;
        else if (fails.length < 5) {
          bad++;
          fails.push(`${repo.split("/").pop()} top=${top} tests=${includeTests} ex=${JSON.stringify(excludeDirs)}\n  TS: ${n(ts).slice(0, 300)}\n  RS: ${n(rs).slice(0, 300)}`);
        } else bad++;
      }
    }
  }
}

rmSync(synth, { recursive: true, force: true });
console.log(`warm-hubs parity: ${ok} ok / ${bad} bad`);
console.log(`  (repos ${repos.length}, comparisons ${compared}, non-empty ${nonEmpty}, hubs ranked ${totalHubs}, top fan-in seen ${maxFan}, cuts landing inside a tie plateau ${cutInTie})`);
for (const x of fails) console.log("  " + x);
if (bad) process.exit(1);
