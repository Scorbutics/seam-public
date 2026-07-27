// SEMANTIC DEF RECALL parity — `embedScoreDefs`, the recall half of anchor selection. The structural scan
// finds what a NAME reaches; this finds what a SENTENCE means, so it is what decides which anchors an
// `--auto --intent` run even considers.
//
// Scores are floats from a real model, so this compares the ORDER (which is what every caller reads) and the
// scores to a tolerance, not bit-for-bit. What IS compared exactly is the deterministic half: the lexical
// pre-filter's kept set — that runs whole-repo before the embed, and a def dropped there can never rank.
//
// Skipped when the embedding runtime is absent on either side (both engines return [] by design).
//
//   bun rust/parity/defembed.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { embedScoreDefs, lexicalPreFilter, transformersAvailable } from "../../ts/src/codebase/scan/def_embed.js";
import { enumerate_defs } from "../../ts/src/codebase/scan/def_table.js";
const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

// BOTH ENGINES ON THE SAME PRECISION — the finding rust/parity/embed.ts encodes: on the INT8 weights the two
// ONNX runtimes disagree by ~1e-2 on a cosine, which is enough to swap near-ties, and the ORDER is the only
// thing a caller reads. On fp32 they agree to ~1e-7. So the comparison below is only meaningful with the
// weights pinned, and `process.env` does not cross the napi boundary — hence syncSeamEnv.
process.env.SEAM_EMBED_QUANTIZED = "0";
addon.syncSeamEnv(Object.entries(process.env).filter(([k]) => k.startsWith("SEAM_")).map(([k, v]) => [k, String(v)]));

const repo = mkdtempSync(join(tmpdir(), "seam-defembed-"));
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
w("package.json", `{ "name": "de", "version": "1.0.0" }\n`);
w("src/payment.ts", `/** Charge a customer's card and record the payment. */\nexport function chargeCard(id: string) { return id; }\n`);
w("src/booking.ts", `/** Create a booking for a slot. */\nexport function createBooking(slot: number) { return slot; }\nexport function cancelBooking(id: string) { return id; }\n`);
w("src/util.ts", `export function clamp(n: number) { return n; }\nexport function parseThing(s: string) { return s; }\n`);
w("src/mailer.ts", `/** Send the confirmation email after a booking. */\nexport function sendConfirmation(to: string) { return to; }\n`);

let fails = 0;
const eq = (label: string, ts: unknown, rs: unknown) => {
  const a = JSON.stringify(ts, null, 1), b = JSON.stringify(rs, null, 1);
  if (a === b) { console.log(`  ok   ${label}`); return; }
  fails++; console.log(`  FAIL ${label}\n    ts: ${a}\n    rs: ${b}`);
};

// ── the DETERMINISTIC half: the lexical pre-filter, compared exactly ─────────────────────────────────────
console.log("lexicalPreFilter (deterministic — runs before any embedding)");
{
  const defs = await enumerate_defs(repo, 15000, undefined, { moduleDefs: true });
  for (const [intent, m] of [["how is a booking created", 3], ["payment charge", 2], ["", 3], ["booking", 99]] as const) {
    const terms = [...new Set(intent.split(/[^A-Za-z0-9]+/).flatMap((r) => r.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/)).map((x) => x.toLowerCase()).filter((x) => x.length >= 3))].sort();
    const ts = lexicalPreFilter(defs, terms, m).map((d: any) => `${d.name} ${d.file}`);
    const rs = addon.lexicalPreFilter(repo, terms, m) as string[];
    eq(`prefilter("${intent}", m=${m})`, ts, rs);
  }
}

// ── the EMBEDDED half: order first, then scores to tolerance ─────────────────────────────────────────────
if (!(await transformersAvailable())) {
  console.log("\nembedding runtime absent — both engines return [] by design; nothing to compare");
} else {
  console.log("embedScoreDefs");
  for (const intent of ["how is a booking created", "charge a card", "send an email"]) {
    const ts = await embedScoreDefs(repo, intent);
    const rs = addon.embedScoreDefs(repo, intent, null) as any[];
    eq(`order("${intent}")`, ts.map((s: any) => `${s.def.name} ${s.def.file}`), rs.map((s: any) => `${s.def.name} ${s.def.file}`));
    const drift = ts.map((s: any, i: number) => Math.abs(s.score - (rs[i]?.score ?? 0))).reduce((a, b) => Math.max(a, b), 0);
    eq(`scores within 1e-5 ("${intent}")`, drift < 1e-5, true);
    // the `vec` rides along for the centroid border — same dimension, same values
    eq(`vec dim ("${intent}")`, ts[0]?.vec.length, rs[0]?.vec.length);
  }
  // FOOTPRINT-SCOPED: `files` bounds extraction and turns OFF both moduleDefs and the pre-filter.
  const files = ["src/booking.ts", "src/mailer.ts"];
  const tsS = await embedScoreDefs(repo, "confirm a booking", new Set(files));
  const rsS = addon.embedScoreDefs(repo, "confirm a booking", files) as any[];
  eq("scoped order", tsS.map((s: any) => `${s.def.name} ${s.def.file}`), rsS.map((s: any) => `${s.def.name} ${s.def.file}`));
}

rmSync(repo, { recursive: true, force: true });
console.log(fails ? `\n${fails} MISMATCH(ES)` : "\nall identical");
process.exit(fails ? 1 : 0);
