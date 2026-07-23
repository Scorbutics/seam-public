// FULL-GROW parity harness (G5) — TS structural grow_to_terminals vs the Rust addon's growToTerminals, over the
// COMPLETE grow (P1 seed → P3 seed-coupling → P2 wave → P3 DEEP fan-couple). growcoupled (G4) only checks
// seed+coupling (maxNodes:1, no wave), so this is the ONLY harness that exercises the deep fan-couple.
//
// Compares by node CONTENT (file#range#kind#symbol#coupling) and edges by endpoint CONTENT (id-independent, so the
// dc/fc id-prefix difference is ignored). Reports node-set, node-ORDER, and content-edge diffs.
//
//   bun rust/parity/growfull.ts <repo> <file> <symbol> [maxSteps] [maxNodes]
// Run with SEAM_GRAPH_CACHE=0 (TS warm cache is not a faithful oracle). --data-coupling is floor here (no LLM).
//
// KNOWN OPEN DIVERGENCE (2026-07-24): the deep fan-couple picks different REPRESENTATIVE producers for shared
// hub/egress boundaries — ~34/1269 edges (2.7%) in the capped (default) config, deterministic (0 diff run-to-run),
// larger with SEAM_PER_NODE_BUDGET=0 (the cap masks a base complement-set difference). Node set + node ORDER are
// identical; the seed coupling is byte-identical. Root is in the deep-fan crossing production, not the seed.

import { createRequire } from "node:module";
import { grow_to_terminals } from "../../ts/src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";

const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

const [, , repo, file, symbol, stepsA, nodesA] = process.argv;
const maxSteps = parseInt(stepsA ?? "12", 10);
const maxNodes = parseInt(nodesA ?? "80", 10);

const nk = (n: any) => `${n.file}#${n.range?.[0]}#${n.kind}#${n.symbol}#${n.coupling ? "C" : ""}`;
const ekOf = (m: Map<string, string>) => (e: any) => `${m.get(e.from)} >${e.kind}:${e.op ?? ""}:${e.line ?? ""}> ${m.get(e.to)}`;

const ctx = new EngineCtx();
const [ts] = await grow_to_terminals(repo, file, symbol, { maxSteps, maxNodes, dataCoupling: true, dataCouplingLlm: false, structuralGrow: true, ctx } as any);
const rust = addon.growToTerminals(repo, file, symbol, true, maxSteps, maxNodes);

const tn = ts.nodes.map(nk), rn = rust.nodes.map(nk);
const tnSet = new Set(tn), rnSet = new Set(rn);
const onlyTsN = [...tnSet].filter((k) => !rnSet.has(k));
const onlyRuN = [...rnSet].filter((k) => !tnSet.has(k));

let orderDiff = -1;
for (let i = 0; i < Math.min(tn.length, rn.length); i++) if (tn[i] !== rn[i]) { orderDiff = i; break; }

const mT = new Map(ts.nodes.map((n: any) => [n.id, nk(n)]));
const mR = new Map(rust.nodes.map((n: any) => [n.id, nk(n)]));
const teSet = new Set(ts.edges.map(ekOf(mT)));
const reSet = new Set(rust.edges.map(ekOf(mR)));
const onlyTsE = [...teSet].filter((k) => !reSet.has(k));
const onlyRuE = [...reSet].filter((k) => !teSet.has(k));

console.log(`full-grow parity ${repo} ${file}#${symbol} [steps=${maxSteps} nodes=${maxNodes}]`);
console.log(`  nodes: TS=${ts.nodes.length} Rust=${rust.nodes.length} | only-TS=${onlyTsN.length} only-Rust=${onlyRuN.length} | order-identical=${orderDiff === -1}`);
console.log(`  edges: TS=${ts.edges.length} Rust=${rust.edges.length} | content only-TS=${onlyTsE.length} only-Rust=${onlyRuE.length}`);
if (onlyTsN.length) console.log("  only-TS nodes:", onlyTsN.slice(0, 6));
if (onlyRuN.length) console.log("  only-Rust nodes:", onlyRuN.slice(0, 6));
if (onlyTsE.length) console.log("  only-TS edges:\n    " + onlyTsE.slice(0, 6).join("\n    "));
if (onlyRuE.length) console.log("  only-Rust edges:\n    " + onlyRuE.slice(0, 6).join("\n    "));

const nodesOk = onlyTsN.length === 0 && onlyRuN.length === 0;
const edgesOk = onlyTsE.length === 0 && onlyRuE.length === 0;
console.log(`  RESULT: nodes ${nodesOk ? "OK" : "DIFF"} / edges ${edgesOk ? "OK" : "DIFF"} / order ${orderDiff === -1 ? "OK" : "DIFF"}`);
process.exit(nodesOk && edgesOk && orderDiff === -1 ? 0 : 1);
