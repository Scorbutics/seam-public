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
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

// BOTH ENGINES ON THE SAME PRECISION. This is the finding this harness exists to encode: on the INT8-quantized
// weights the two runtimes (onnxruntime-web/WASM vs native ORT) disagree by ~1e-2 on a cosine — enough to swap
// near-ties, and ordering is the only thing the grow reads. On fp32 they agree to 3.7e-7 and rank identically.
// So the requirement is not "port the field", it is "both engines use the SAME weights".
process.env.SEAM_EMBED_QUANTIZED = "0";
// `process.env` does NOT cross the napi boundary — the addon reads its own process environment, which is why
// this codebase has `syncSeamEnv` at all. Setting the variable without syncing it silently leaves the addon on
// the quantized weights, and the harness then "measures" a divergence it created itself.
addon.syncSeamEnv(Object.entries(process.env).filter(([k]) => k.startsWith("SEAM_")).map(([k, v]) => [k, String(v)]));
const { pipeline, env } = await import("../../ts/node_modules/@xenova/transformers/src/transformers.js");
env.allowLocalModels = true;
env.localModelPath = "/home/scorbutics/seam-phase0/ts/node_modules/@xenova/transformers/.cache";

const INTENT = "how is a booking saved to the database";
// SHORT STRINGS UNDERSTATE THE RISK. This harness compares symbol NAMES, and on those the two runtimes agreed
// to 3.7e-7 while the real field disagreed by ~3e-2 — because the grow embeds `embedString` passages
// (signature + enclosing + path + doc + BODY), and the Rust `tokenizers` crate honoured `tokenizer.json`'s
// `truncation.max_length = 128` while transformers.js ignores that section and truncates at `model_max_length`
// (512). Anything past 128 tokens was silently dropped on one side only. Fixed in seam-embed; noted here
// because this harness CANNOT see that class of bug — see rust/parity/growintent.ts, which can.
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
// LONG passages, deliberately over 128 tokens. The grow does not embed symbol names — it embeds `embedString`
// (signature + enclosing + path + doc + BODY). A sequence-length difference between the two tokenizers is
// invisible on short input and shifts every long score, so the sample has to contain both. This is the bug this
// harness missed once already: Rust honoured tokenizer.json's `truncation.max_length = 128`, transformers.js
// uses `model_max_length` (512), and the field disagreed by ~3e-2 on real def strings while this harness read
// 3.7e-7 on names.
const LONG: string[] = [
  `method patchHandler(req: NextApiRequest, res: NextApiResponse) in AttendeeHandler — apps/api/v1/pages/api/attendees/[id]/_patch.ts :: Edit an existing attendee { const { userId, isSystemWideAdmin, query, body } = req; const { id } = schemaQueryIdParseInt.parse(query); const data = schemaAttendeeEditBodyParams.parse(body); const attendee = await prisma.attendee.findUnique({ where: { id }, select: { booking: { select: { userId: true } } } }); if (!attendee) throw new HttpError({ statusCode: 404, message: "Attendee not found" }); if (!isSystemWideAdmin && attendee.booking.userId !== userId) throw new HttpError({ statusCode: 403, message: "Forbidden" }); const updated = await prisma.attendee.update({ where: { id }, data }); return { attendee: schemaAttendeeReadPublic.parse(updated) }; }`,
  `function saveBookingToDatabase(input: BookingCreateInput, tx: PrismaTransaction) — packages/features/bookings/lib/handleNewBooking/createBooking.ts :: Persist a confirmed booking and its attendees { const booking = await tx.booking.create({ data: { uid, title, startTime, endTime, eventTypeId, userId, status: BookingStatus.ACCEPTED, attendees: { createMany: { data: attendees } }, references: { createMany: { data: references } } }, include: { attendees: true, references: true } }); await tx.bookingSeat.createMany({ data: seats }); logger.info("booking persisted", { uid: booking.uid }); return booking; }`,
  `function renderCalendarHeaderRow(props: CalendarHeaderProps) — packages/ui/components/calendar/CalendarHeader.tsx :: Presentational header for the month grid { const { month, year, onPrev, onNext, locale } = props; const label = useMemo(() => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(year, month)), [month, year, locale]); return (<div className="flex items-center justify-between px-4 py-2"><Button onClick={onPrev} aria-label="previous month" /><span className="text-sm font-medium">{label}</span><Button onClick={onNext} aria-label="next month" /></div>); }`,
];
const VALUES = defs.length >= 50 ? [...defs, ...LONG] : [
  "saveBooking", "createBooking", "bookingRepository.insert", "db.booking.update",
  "renderCalendarHeader", "formatDateLabel", "parseTimezoneOffset",
  "sendConfirmationEmail", "logger.debug", "cssVariablesForTheme",
];

if (!addon.embedAvailable()) { console.log("embed parity: SKIPPED — no local model"); process.exit(0); }
let embedder: any;
try { embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: false }); }
catch { console.log("embed parity: SKIPPED — the fp32 weights are not cached locally"); process.exit(0); }
const embedOne = async (t: string): Promise<number[]> => Array.from((await embedder([t], { pooling: "mean", normalize: true })).data as Float32Array);
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const iv = await embedOne(INTENT);
const ts = new Map<string, number>();
for (const v of VALUES) ts.set(v, dot(iv, await embedOne(v)));
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
console.log(`  max |Δcosine| = ${maxDelta.toExponential(3)}   (fp32 both sides; on int8 weights this is ~1e-2 and swaps near-ties)`);
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
const OK = tsOrder === rsOrder && topOk && maxDelta < 1e-5;
console.log(OK ? "\n→ the field agrees on every DECISION (full ranking + top-K sets)" : "\n→ DIVERGENT — the field would steer the walk differently");
process.exit(OK ? 0 : 1);
