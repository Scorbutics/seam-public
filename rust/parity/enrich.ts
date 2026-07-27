// INTERFACE-CONSUMERS + FRAMEWORK-ENTRY + MERGE parity — the three enrichment steps `--scan` runs on every
// footprint before it decomposes, and the last TypeScript the CLI reached into scan/ for.
//
//   implemented_interfaces  the anchor's own interfaces (the DI facade a consumers grow misses)
//   is_framework_entry      a declaratively-wired root — the difference between "flow enters here" and "dead"
//   merge_resolved          how the enrichment is folded back in; content-keyed, so it must be IDEMPOTENT
//
//   bun rust/parity/enrich.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { implemented_interfaces, is_framework_entry, build_footprint, merge_resolved } from "../../ts/src/codebase/scan/index.js";
const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

const repo = mkdtempSync(join(tmpdir(), "seam-enrich-"));
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
w("package.json", `{ "name": "enrich", "version": "1.0.0" }\n`);
// Java: an in-repo interface, an EXTERNAL one (never declared here → the framework-callback signal), and an
// annotated method (the other entry signal, presence-not-name).
w("src/UserProvider.java", `package a;\npublic interface UserProvider { void save(String id); }\n`);
w("src/UserAdapter.java", `package a;\npublic class UserAdapter implements UserProvider, MessageListener {\n  public void save(String id) { }\n  public void onMessage(String m) { }\n}\n`);
w("src/Resource.java", `package a;\npublic class Resource {\n  @GET\n  public String list() { return "x"; }\n  public String plain() { return "y"; }\n}\n`);
// TS: an implements clause under class_heritage + a decorator sibling.
w("src/store.ts", `export interface Store { put(k: string): void }\nexport class MemStore implements Store { put(k: string) { } }\n`);
w("src/svc.ts", `import { MemStore } from "./store.js";\nexport class Svc { run() { return new MemStore().put("k"); } }\n`);

let fails = 0;
const eq = (label: string, ts: unknown, rs: unknown) => {
  const a = JSON.stringify(ts, null, 1), b = JSON.stringify(rs, null, 1);
  if (a === b) { console.log(`  ok   ${label}`); return; }
  fails++; console.log(`  FAIL ${label}\n    ts: ${a}\n    rs: ${b}`);
};

console.log("implemented_interfaces");
for (const [f, s] of [["src/UserAdapter.java", "UserAdapter"], ["src/store.ts", "MemStore"], ["src/Resource.java", "Resource"],
                      ["src/UserProvider.java", "UserProvider"], ["src/store.ts", "NotAClass"]] as const)
  eq(`${f}#${s}`, await implemented_interfaces(repo, f, s), addon.implementedInterfaces(repo, f, s));

console.log("is_framework_entry");
for (const [f, s] of [["src/Resource.java", "list"], ["src/Resource.java", "plain"], ["src/UserAdapter.java", "onMessage"],
                      ["src/UserAdapter.java", "save"], ["src/UserAdapter.java", "UserAdapter"], ["src/store.ts", "put"],
                      ["src/svc.ts", "run"], ["src/Resource.java", "ghost"]] as const)
  eq(`${f}#${s}`, await is_framework_entry(repo, f, s), addon.isFrameworkEntry(repo, f, s));

console.log("merge_resolved");
{
  // The CLI's own shape: a consumers footprint enriched with the interface's consumers, attached at the
  // interface node. Compared field-by-field, then RE-merged to pin idempotence (the CLI re-grows anchors).
  const base = await build_footprint(repo, "src/store.ts", "MemStore", { direction: "up", dataCoupling: false });
  const add = await build_footprint(repo, "src/store.ts", "Store", { direction: "up", dataCoupling: false });
  // A CLASS anchor ids itself by SYMBOL, not `n1` — so read the id off the graph rather than assuming, which
  // is exactly what the CLI does (`merge_resolved(data, cons, node.id)`).
  const at = base.anchor?.id;
  const rsBase = addon.buildFootprint(repo, "src/store.ts", "MemStore", "up", false);
  const rsAdd = addon.buildFootprint(repo, "src/store.ts", "Store", "up", false);
  eq("anchor id agrees", at, rsBase.anchorId);
  const tsM = merge_resolved(base, add, at);
  const rsM = addon.mergeResolved(rsBase, rsAdd, rsBase.anchorId);
  eq("merged nodes", tsM.nodes.map((n: any) => `${n.symbol} ${n.file}`), rsM.nodes.map((n: any) => `${n.symbol} ${n.file}`));
  eq("merged edges", tsM.edges.map((e: any) => `${e.from}->${e.to} ${e.kind}`), rsM.edges.map((e: any) => `${e.from}->${e.to} ${e.kind}`));
  eq("merged anchors", tsM.anchors ?? [], rsM.anchors);
  eq("idempotent (ts)", tsM.nodes.length, merge_resolved(tsM, add, at).nodes.length);
  eq("idempotent (rs)", rsM.nodes.length, addon.mergeResolved(rsM, rsAdd, rsBase.anchorId).nodes.length);
}

rmSync(repo, { recursive: true, force: true });
console.log(fails ? `\n${fails} MISMATCH(ES)` : "\nall identical");
process.exit(fails ? 1 : 0);
