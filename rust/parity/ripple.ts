// DEPTH-2 RIPPLE + VERIFIED ATTRIBUTION parity — the two options the CLI's `scan.build_footprint` passes that
// the core did not implement, which is why `--scan` was still routed through the TypeScript builder.
//
//   depth >= 2   the ENVIRONMENT frontier: each depth-1 consumer that is an EXPORTED symbol gets ITS importers
//                wired in. Node IDS are `n{counter}` assigned in WALK ORDER, so this compares the ids too —
//                an equal node SET under a different id assignment would still break every edge downstream.
//   verified     the extension's LSP method attribution for a CLASS anchor. Where present it REPLACES the
//                receiver-agnostic AST read; where EMPTY after filtering to the class's own methods it must
//                NOT blank out the real read.
//
// The ripple also has a kill-switch (SEAM_RIPPLE_INDEX=0 → the old full walk) whose whole claim is that it
// changes NOTHING but the cost, so both engines are run under both settings and all four must agree.
//
//   bun rust/parity/ripple.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { build_footprint } from "../../ts/src/codebase/scan/index.js";
const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

const repo = mkdtempSync(join(tmpdir(), "seam-ripple-"));
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
w("package.json", `{ "name": "ripple", "version": "1.0.0" }\n`);
// core ← mid ← {app, other}: `mid` is an EXPORTED depth-1 consumer, so depth 2 must pull in its importers.
w("src/core.ts", `export function persist(id: string) { return id; }\n`);
w("src/mid.ts", `import { persist } from "./core.js";\nexport function save(id: string) { return persist(id); }\nexport function unrelated() { return 0; }\n`);
w("src/app.ts", `import { save } from "./mid.js";\nexport function handler(id: string) { return save(id); }\n`);
w("src/other.ts", `import { save } from "./mid.js";\nexport function job(id: string) { return save(id); }\n`);
w("src/far.ts", `import { handler } from "./app.js";\nexport function outer(id: string) { return handler(id); }\n`);   // depth 3 — must NOT appear
w("src/noise.ts", `export function nothing() { return 1; }\n`);
// A CLASS anchor for the verified path.
w("src/repo.ts", `export class Repo {\n  save(id: string) { return id; }\n  load(id: string) { return id; }\n}\n`);
w("src/use.ts", `import { Repo } from "./repo.js";\nexport function run(id: string) {\n  const r = new Repo();\n  return r.save(id);\n}\n`);

let fails = 0;
const eq = (label: string, ts: unknown, rs: unknown) => {
  const a = JSON.stringify(ts, null, 1), b = JSON.stringify(rs, null, 1);
  if (a === b) { console.log(`  ok   ${label}`); return; }
  fails++; console.log(`  FAIL ${label}\n    ts: ${a}\n    rs: ${b}`);
};
// Compare the graph the way everything downstream reads it: ids INCLUDED, because the edges cite them.
const shape = (g: any) => ({
  nodes: (g.nodes ?? []).map((n: any) => `${n.id} ${n.symbol} ${n.file} ${n.kind} [${n.range}] enc=${n.enclosing}`),
  edges: (g.edges ?? []).map((e: any) => `${e.from}->${e.to} ${e.kind} ${e.provenance}`),
});

console.log("depth-2 ripple");
for (const ripple of ["1", "0"]) {
  process.env.SEAM_RIPPLE_INDEX = ripple;
  addon.syncSeamEnv([["SEAM_RIPPLE_INDEX", ripple]]);
  addon.resetCaches(null);
  const label = `SEAM_RIPPLE_INDEX=${ripple}`;
  for (const depth of [1, 2]) {
    const ts = await build_footprint(repo, "src/core.ts", "persist", { direction: "up", depth, dataCoupling: false });
    const rs = addon.buildFootprint(repo, "src/core.ts", "persist", "up", false, depth, null, null);
    eq(`${label} depth=${depth}`, shape(ts), shape(rs));
  }
  // The RIPPLE'S OWN CLAIM: depth 2 reaches app+other (mid's importers) and stops there — `far` is depth 3.
  const d2 = await build_footprint(repo, "src/core.ts", "persist", { direction: "up", depth: 2, dataCoupling: false });
  const files = [...new Set(d2.nodes.map((n: any) => n.file))].sort();
  eq(`${label} reaches exactly the depth-2 frontier`, files, ["src/app.ts", "src/core.ts", "src/mid.ts", "src/other.ts"]);
}
delete process.env.SEAM_RIPPLE_INDEX;
addon.syncSeamEnv([["SEAM_RIPPLE_INDEX", ""]]);
addon.resetCaches(null);

console.log("verified attribution (CLASS anchor)");
{
  const plain = await build_footprint(repo, "src/repo.ts", "Repo", { direction: "up", dataCoupling: false });
  eq("no attribution", shape(plain), shape(addon.buildFootprint(repo, "src/repo.ts", "Repo", "up", false, null, null, null)));
  // an attribution naming a REAL method → it replaces the AST read
  const v = { "src/use.ts": { load: 3 } };
  const tsV = await build_footprint(repo, "src/repo.ts", "Repo", { direction: "up", verified: v, dataCoupling: false });
  const rsV = addon.buildFootprint(repo, "src/repo.ts", "Repo", "up", false, null, null, [["src/use.ts", "load", "3"]]);
  eq("verified replaces the AST read", shape(tsV), shape(rsV));
  // an attribution naming NOTHING the class declares → filtered to empty, so the AST read must SURVIVE
  const tsE = await build_footprint(repo, "src/repo.ts", "Repo", { direction: "up", verified: { "src/use.ts": { ghost: 9 } }, dataCoupling: false });
  const rsE = addon.buildFootprint(repo, "src/repo.ts", "Repo", "up", false, null, null, [["src/use.ts", "ghost", "9"]]);
  eq("empty-after-filter keeps the AST read", shape(tsE), shape(rsE));
  eq("…and that read is the real one", shape(tsE), shape(plain));
}

rmSync(repo, { recursive: true, force: true });
console.log(fails ? `\n${fails} MISMATCH(ES)` : "\nall identical");
process.exit(fails ? 1 : 0);
