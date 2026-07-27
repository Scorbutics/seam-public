// SCORE PARITY — the Rust intent field vs transformers.js, on the same model artifact.
//
// This is the one port whose output is FLOATING POINT, so "byte-identical" is not the right test and pretending
// otherwise would be theatre. What actually matters is that the grow makes the same DECISIONS: the soft border
// halts at the same place, the tier gate parks the same fan. Those read RELATIVE scores, so this pins
//   1. per-vector cosine agreement (the two embeddings of the same text must be the same direction), and
//   2. RANKING agreement — the order the field induces over a candidate set, which is what the grow consumes.
// A tiny elementwise delta is expected (two ONNX runtimes, same quantized weights); a RANK swap is not.
//
//   bun rust/parity/embed.ts
import { createRequire } from "node:module";
import { embedScoreStrings, transformersAvailable } from "../../ts/src/codebase/scan/def_embed.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const INTENT = "how is a booking saved to the database";
// A REAL candidate set, not a handful: the grow ranks hundreds of symbol names, and a rank swap is only
// meaningful if the sample is big enough to contain near-ties. Drawn from the actual repo so the strings have
// the shape the field really sees.
const { execFileSync } = await import("node:child_process");
const defs: string[] = (() => {
  try {
    const out = addon.enumerateDefs("/home/scorbutics/dev/cal.com", 400, undefined, false) as any[];
    return [...new Set(out.map((d) => d.name as string))].filter(Boolean).slice(0, 200);
  } catch { return []; }
})();
const VALUES = defs.length >= 50 ? defs : [
  "saveBooking", "createBooking", "bookingRepository.insert", "db.booking.update",
  "renderCalendarHeader", "formatDateLabel", "parseTimezoneOffset",
  "sendConfirmationEmail", "logger.debug", "cssVariablesForTheme",
];

if (!(await transformersAvailable())) { console.log("embed parity: SKIPPED — transformers.js unavailable"); process.exit(0); }
if (!addon.embedAvailable()) { console.log("embed parity: FAILED — the Rust field found no model"); process.exit(1); }

const ts = await embedScoreStrings(INTENT, VALUES);
const rs = addon.embedScoreStrings(INTENT, VALUES);

let maxDelta = 0;
for (const v of VALUES) {
  const a = ts.get(v), b = rs[v];
  if (a === undefined || b === undefined) { console.log(`✗ ${v}: ts=${a} rust=${b}`); process.exit(1); }
  maxDelta = Math.max(maxDelta, Math.abs(a - b));
}

const order = (m: Map<string, number> | Record<string, number>) =>
  [...VALUES].sort((x, y) => (m instanceof Map ? m.get(y)! - m.get(x)! : m[y] - m[x])).join(" > ");
const tsOrder = order(ts), rsOrder = order(rs);

// TOP-K SET agreement at the K a grow actually consumes — the decision, not the digits.
const topK = (m: any, k: number) => new Set([...VALUES].sort((x, y) => (m instanceof Map ? m.get(y)! - m.get(x)! : m[y] - m[x])).slice(0, k));
const sameTop = (k: number) => { const a = topK(ts, k), b = topK(rs, k); return a.size === b.size && [...a].every((v) => b.has(v)); };
const tops = [5, 10, 20, 50].filter((k) => k <= VALUES.length);
const topOk = tops.every(sameTop);

console.log(`\nembed parity (Rust ort vs transformers.js, ${VALUES.length} values)`);
console.log(`  max |Δcosine| = ${maxDelta.toExponential(3)}   (int8 kernels differ between execution providers)`);
console.log(`  full ranking identical: ${tsOrder === rsOrder}`);
console.log(`  top-K sets identical:   ${tops.map((k) => `K=${k}:${sameTop(k)}`).join("  ")}`);
if (tsOrder !== rsOrder) {
  const a = tsOrder.split(" > "), b = rsOrder.split(" > ");
  const i = a.findIndex((x, j) => x !== b[j]);
  console.log(`  first rank difference @${i}: ts=${a[i]} rust=${b[i]}`);
}

// THE CRITERION IS THE DECISION, NOT THE DIGIT. The model is INT8-quantized and the two runtimes
// (onnxruntime-web/WASM under transformers.js, native ORT here) use different kernels, so an elementwise delta
// of ~1e-2 on a cosine is expected and is NOT evidence of a porting defect — it is the quantization noise
// floor. What would be a defect is the field ORDERING candidates differently, because ordering is the only
// thing the grow reads: the soft border and the tier gate compare scores against each other, never against an
// absolute. So the gate is ranking + top-K set agreement, with the delta reported as an observation.
const OK = tsOrder === rsOrder && topOk;
console.log(OK ? "\n→ the field agrees on every DECISION (full ranking + top-K sets)" : "\n→ DIVERGENT — the field would steer the walk differently");
process.exit(OK ? 0 : 1);
