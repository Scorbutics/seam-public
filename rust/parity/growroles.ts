// Byte-identical harness (G1) — Rust from_resolved_graph + assign_roles + _is_crossing vs TS, over the SAME
// footprint. For each anchor we build a rich footprint (both directions + dataCoupling) in TS, then feed that
// one graph to BOTH the TS graph_ir/roles and the Rust `growRoles`, asserting the role-per-node list and the
// resolved-crossing-target set match exactly. Isolates the grow's per-wave derivations from the footprint build.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build_footprint } from "../../ts/src/codebase/scan/footprint.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
import { from_resolved_graph } from "../../ts/src/core/graph_ir.js";
import { assign_roles } from "../../ts/src/codebase/seams/roles.js";
import { _is_crossing } from "../../ts/src/codebase/seams/clusters.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "60", 10);
const glob = process.argv[4] ?? "*.java";
const kindWanted = process.argv[5] ?? "method";
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", glob], { maxBuffer: 512 * 1024 * 1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);

const toDto = (g: any) => ({
  anchorId: g.anchor?.id ?? "", anchorSymbol: g.anchor?.symbol ?? "", anchorFile: g.anchor?.file ?? "",
  anchorRange: g.anchor?.range ?? [0, 0], language: g.language ?? "",
  nodes: g.nodes.map((n: any) => ({ id: n.id, symbol: n.symbol ?? "", kind: n.kind ?? "", file: n.file ?? "", range: n.range ?? [0, 0], enclosing: n.enclosing ?? "", complexity: n.complexity ?? 0, coupling: !!n.coupling, direction: n.direction ?? undefined })),
  edges: g.edges.map((e: any) => ({ from: e.from, to: e.to, kind: e.kind ?? "", provenance: e.provenance ?? "", line: e.line ?? undefined, op: e.op ?? undefined })),
  blindspots: [], unresolved: [], anchors: g.anchors ?? [], resolvedMethods: [],
});

const tsDerive = (ts: any): [string, string] => {
  const gg = from_resolved_graph(ts);
  assign_roles(gg);
  const roles = [...gg.nodes.values()].map((n: any) => `${n.id}=${n.role}`).join("\n");
  const seen = new Set<string>(); const cross: string[] = [];
  for (const e of gg.resolved_edges()) if (_is_crossing(e) && !seen.has(e.dst)) { seen.add(e.dst); cross.push(e.dst); }
  return [roles, cross.join(",")];
};

const lang = glob.includes(".ts") ? "typescript" : "java";
const ctx = new EngineCtx();
let ok = 0, bad = 0, ne = 0; const fails: string[] = [];
for (let i = 0; i < files.length; i++) {
  const file = files[i]; const text = readFileSync(`${repo}/${file}`, "utf8"); if (!/^[\x00-\x7F]*$/.test(text)) continue;
  const units = addon.namedUnits(text, lang) as any[];
  const u = units.find((x) => x.kind === kindWanted); if (!u) continue;
  let ts: any; try { ts = await build_footprint(repo, file, u.name, { direction: "both", dataCoupling: true, llm: false, ctx }); } catch { continue; }
  if (!ts || !ts.nodes.length) continue;
  if (ts.nodes.length > 1) ne++;
  const [tsRoles, tsCross] = tsDerive(ts);
  const r = addon.growRoles(toDto(ts));
  const rustRoles = r.roles.map((x: any) => `${x.id}=${x.role}`).join("\n");
  const rustCross = (r.crossings as string[]).join(",");
  if (tsRoles === rustRoles && tsCross === rustCross) ok++;
  else {
    bad++;
    if (fails.length < 12) {
      if (tsRoles !== rustRoles) { const tl = tsRoles.split("\n"), rl = rustRoles.split("\n"); const k = tl.findIndex((l, j) => l !== rl[j]); fails.push(`✗ roles ${file}#${u.name}\n  ts:   ${tl[k] ?? "<none>"}\n  rust: ${rl[k] ?? "<none>"}`); }
      else fails.push(`✗ cross ${file}#${u.name}\n  ts:   ${tsCross}\n  rust: ${rustCross}`);
    }
  }
}
console.log(`\ngrowRoles parity over ${glob} [${kindWanted}]: ${ok} ok / ${bad} bad (non-trivial ${ne})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
