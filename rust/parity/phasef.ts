// PHASE F — end-to-end: the Rust CORE GROW driving Seam codebase mode. For each anchor we grow the footprint
// in BOTH engines, feed each through the SAME deterministic TS skeleton decompose (decompose{skeleton:true}),
// and compare the resulting seam model canonicalized by node identity (file:start — the transient ids differ).
// A match proves: the Rust grow produces the same end-to-end SKELETON as the TS grow. dataCoupling:false
// (structural — where the grow is byte-identical); pass "1" as arg 6 to include the coupling overlay.
process.env.SEAM_PARALLEL_GROW = "0";
process.env.SEAM_GRAPH_CACHE = "0"; // compare pure-compute vs pure-compute (TS build_footprint_cached conflates same-name symbols)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { grow_to_terminals } from "../../ts/src/codebase/grow/orchestrate.js";
import { decompose } from "../../ts/src/codebase/codebase.js";
import { from_resolved_graph } from "../../ts/src/core/graph_ir.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "12", 10);
const glob = process.argv[4] ?? "*.java";
const kindWanted = process.argv[5] ?? "method";
const dc = process.argv[6] === "1";
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", glob], { maxBuffer: 512 * 1024 * 1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);

// Rust GraphDto → the `data` shape from_resolved_graph ingests.
const toData = (g: any) => ({
  language: g.language, resolutionQuality: "FULL",
  nodes: g.nodes.map((n: any) => ({ id: n.id, symbol: n.symbol, kind: n.kind, file: n.file, range: n.range, enclosing: n.enclosing, complexity: n.complexity, direction: n.direction ?? undefined, hub: n.hub ? { reason: n.hub.reason, fan: n.hub.fan, sampleConsumers: n.hub.sampleConsumers } : undefined })),
  edges: g.edges.map((e: any) => ({ from: e.from, to: e.to, kind: e.kind, provenance: e.provenance, line: e.line ?? undefined, op: e.op ?? undefined })),
  anchor: { id: g.anchorId, symbol: g.anchorSymbol, file: g.anchorFile, range: g.anchorRange },
  anchors: g.anchors,
  blindspots: g.blindspots.map((b: any) => ({ node: b.node, mechanism: b.mechanism, evidence: b.evidence, candidates: b.candidates.map((c: any) => ({ symbol: c.symbol, file: c.file ?? undefined })), persists: b.persists })),
  unresolved: g.unresolved, frontier: g.frontier,
});

// Canonicalize a decompose model: map every node id → "file:start", strip raw ids, stable-stringify.
const canon = (model: any): string => {
  const idToLoc = new Map<string, string>();
  const collect = (obj: any) => {
    if (Array.isArray(obj)) obj.forEach(collect);
    else if (obj && typeof obj === "object") {
      if (typeof obj.id === "string" && obj.file !== undefined && obj.start !== undefined) idToLoc.set(obj.id, `${obj.file}:${obj.start}`);
      Object.values(obj).forEach(collect);
    }
  };
  collect(model);
  const map = (v: any): any => {
    if (typeof v === "string") return idToLoc.get(v) ?? v;
    if (Array.isArray(v)) return v.map(map);
    if (v && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) {
        if (k === "id") continue; // drop the transient id (identity is file:start)
        out[k] = (k === "from" || k === "to" || k === "node" || k === "anchor" || k === "selectedSeam") ? (idToLoc.get(v[k]) ?? v[k]) : map(v[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(map(model));
};

const lang = glob.includes(".ts") ? "typescript" : "java";
let ok = 0, bad = 0, ne = 0; const fails: string[] = [];
for (let i = 0; i < files.length; i++) {
  const file = files[i]; const text = readFileSync(`${repo}/${file}`, "utf8"); if (!/^[\x00-\x7F]*$/.test(text)) continue;
  const units = addon.namedUnits(text, lang) as any[];
  const u = units.find((x) => x.kind === kindWanted); if (!u) continue;
  let tsg: any; try { [tsg] = await grow_to_terminals(repo, file, u.name, { structuralGrow: true, dataCoupling: dc, dataCouplingLlm: false, maxNodes: 80, ctx: new EngineCtx() } as any); } catch { continue; }
  if (!tsg || tsg.nodes.length <= 1) continue;
  const rustg = addon.growToTerminals(repo, file, u.name, dc, 12, 80);
  if (!rustg) { bad++; continue; }
  ne++;
  const mTs = canon(await decompose(from_resolved_graph(tsg), { skeleton: true, repo }));
  const mRust = canon(await decompose(from_resolved_graph(toData(rustg)), { skeleton: true, repo }));
  if (mTs === mRust) ok++;
  else { bad++; if (fails.length < 8) { const a = mTs, b = mRust; let k = 0; while (k < a.length && a[k] === b[k]) k++; fails.push(`✗ ${file}#${u.name}\n  …${a.slice(Math.max(0, k - 40), k + 60)}\n  …${b.slice(Math.max(0, k - 40), k + 60)}`); } }
}
console.log(`\nPhase F end-to-end (Rust grow → TS skeleton decompose) over ${glob} [${kindWanted}] dataCoupling:${dc}: ${ok} ok / ${bad} bad (non-trivial ${ne})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
