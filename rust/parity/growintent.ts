// INTENT-GROW parity harness — the TS wave WITH its intent field vs the Rust wave with the ported one.
//
// growfull covers the STRUCTURAL grow (no intent → no field → the flood is intent-free). This is the other
// half: the five decision points the field feeds — `densify`, the region-centroid, the move-ordering band, the
// soft border, and the tier rule — which together decide what the grow CONTAINS, not merely what order it
// reports. A structural-only comparison cannot see any of them, so it passed all along while they were unported.
//
// THE CRITERION IS THE SET, NOT THE SCORE. The two engines run different ONNX runtimes over the same weights,
// so the cosines differ in the last digits (see rust/parity/embed.ts: 3.7e-7 on fp32). What must agree is the
// DECISION each score feeds: the node set, the node order, and the parked frontier. A near-tie that lands on
// opposite sides of `tierMargin` in the two engines is the one legitimate source of a small diff, and it is
// reported rather than tolerated silently.
//
//   bun rust/parity/growintent.ts <repo> <file> <symbol> "<intent>" [borderTol] [maxSteps] [maxNodes]
// Run with SEAM_GRAPH_CACHE=0 (a warm TS cache is not a faithful oracle).
import { createRequire } from "node:module";
import { grow_to_terminals } from "../../ts/src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";

const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

const [, , repo, file, symbol, intent, tolA, stepsA, nodesA] = process.argv;
if (!repo || !file || !symbol || !intent) {
  console.log('usage: bun rust/parity/growintent.ts <repo> <file> <symbol> "<intent>" [borderTol] [maxSteps] [maxNodes]');
  process.exit(2);
}
const borderTol = tolA && tolA !== "-" ? parseFloat(tolA) : null;
const maxSteps = parseInt(stepsA ?? "12", 10);
const maxNodes = parseInt(nodesA ?? "80", 10);

// BOTH ENGINES ON THE SAME WEIGHTS, and specifically on fp32. The int8 kernels differ between
// onnxruntime-web (transformers.js) and native ORT by up to ~3e-2 on a cosine over real def strings —
// MEASURED on identical input, `_patch.ts` = 0.2741 vs 0.2452 against a 0.25 coupling margin. That is the same
// order as the distance between a real score and the margins the grow compares against, so on int8 a
// borderline complement flips while BOTH engines are working correctly, and this harness cannot tell that
// apart from a porting defect. On fp32 the two agree to 3.7e-7 (rust/parity/embed.ts). `def_embed.ts` reads
// the same knob, so one variable puts both sides on one artifact.
process.env.SEAM_EMBED_QUANTIZED = "0";
// `process.env` does not cross the napi boundary — the addon reads its own process environment.
addon.syncSeamEnv(Object.entries(process.env).filter(([k]) => k.startsWith("SEAM_")).map(([k, v]) => [k, String(v)]));

if (!addon.embedAvailable()) { console.log("intent-grow parity: SKIPPED — no local embedding model"); process.exit(0); }

const nk = (n: any) => `${n.file}#${n.range?.[0]}#${n.kind}#${n.symbol}#${n.coupling ? "C" : ""}`;

const ctx = new EngineCtx();
const [ts] = await grow_to_terminals(repo, file, symbol, {
  maxSteps, maxNodes, dataCoupling: true, dataCouplingLlm: false,
  structuralGrow: false, intent, borderTol, ctx,
} as any);
const rust = addon.growToTerminals(repo, file, symbol, true, {
  maxSteps, maxNodes, intent, structuralGrow: false, borderTol: borderTol ?? undefined,
});
if (!rust) { console.log("intent-grow parity: the Rust grow returned nothing"); process.exit(1); }

const tn = ts.nodes.map(nk), rn = rust.nodes.map(nk);
const tnSet = new Set(tn), rnSet = new Set(rn);
const onlyTsN = [...tnSet].filter((k) => !rnSet.has(k));
const onlyRuN = [...rnSet].filter((k) => !tnSet.has(k));
let orderDiff = -1;
for (let i = 0; i < Math.min(tn.length, rn.length); i++) if (tn[i] !== rn[i]) { orderDiff = i; break; }

// THE PARKED FRONTIER is the tier rule's own output — a node the up-climb declined to follow. Comparing only
// the grown set would miss a tier-3 park that another rule happened to exclude anyway.
const fkey = (f: any) => `${f.file}#${f.symbol}:${f.cutBy ?? ""}`;
const tf = new Set((ts.frontier ?? []).map(fkey)), rf = new Set((rust.frontier ?? []).map(fkey));
const onlyTsF = [...tf].filter((k) => !rf.has(k));
const onlyRuF = [...rf].filter((k) => !tf.has(k));

console.log(`\nintent-grow parity ${file}#${symbol}  intent="${intent}"  tol=${borderTol ?? "off"} [steps=${maxSteps} nodes=${maxNodes}]`);
console.log(`  nodes:    TS=${tn.length} Rust=${rn.length} | only-TS=${onlyTsN.length} only-Rust=${onlyRuN.length} | order-identical=${orderDiff === -1}`);
console.log(`  frontier: TS=${tf.size} Rust=${rf.size} | only-TS=${onlyTsF.length} only-Rust=${onlyRuF.length}`);
if (onlyTsN.length) console.log("  only-TS nodes:  ", onlyTsN.slice(0, 8));
if (onlyRuN.length) console.log("  only-Rust nodes:", onlyRuN.slice(0, 8));
if (onlyTsF.length) console.log("  only-TS parked:  ", onlyTsF.slice(0, 8));
if (onlyRuF.length) console.log("  only-Rust parked:", onlyRuF.slice(0, 8));

const ok = !onlyTsN.length && !onlyRuN.length && orderDiff === -1 && !onlyTsF.length && !onlyRuF.length;
console.log(ok ? "\n→ the two waves CONTAIN the same region and park the same frontier" : "\n→ DIVERGENT — the field steers the two waves differently");
process.exit(ok ? 0 : 1);
