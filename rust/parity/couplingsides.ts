// Byte-identical harness — Rust `coupling_other_sides` vs TS `couplingOtherSides` (the TARGETED cross-stack
// bridge: anchor keys → value-grep → candidate key-scan → complementary role). This is the STRATEGY the
// `otherside.ts` harness does NOT cover: that one compares the index-based primitive, this one the bounded
// walk built on top of it — including BOTH bounds and the truncation note each produces.
//
// Compares, per anchor, the full crossing list (kind|value|file|symbol|edgeKind|provenance) AND the stated
// truncations (kind|value|scanned|total|reason). A truncation mismatch is a real failure: the two engines
// having walked different amounts of the same candidate list means the bound is not a pure function of the
// repo any more.
//
//   bun rust/parity/couplingsides.ts [repo] [maxAnchors]
// Deterministic FLOOR only — the TS bridge's LLM anchor-key pass has no Rust counterpart, so it is off here
// (llm: false), which is what SEAM_COUPLING=floor gives a user.
import { createRequire } from "node:module";
import { couplingOtherSides } from "../../ts/src/codebase/coupling/index.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/cal.com";
const maxAnchors = parseInt(process.argv[3] ?? "12", 10);

// Anchors = functions/methods across the repo, sampled evenly — the realistic overlay targets. Anchors with no
// boundary at all return [] on both sides; they are counted but flagged, so a harness that silently compares
// nothing but empties can't read as green.
const defs = (addon.enumerateDefs(repo, 200000, undefined, false) as any[])
  .filter((d) => /\.(ts|tsx|js)$/.test(d.file) && ["function", "method"].includes(d.kind) && d.name);
const step = Math.max(1, Math.floor(defs.length / maxAnchors));
const anchors = defs.filter((_, i) => i % step === 0).slice(0, maxAnchors);

const serSides = (xs: any[]) =>
  xs.map((s) => `${s.kind}|${s.value}|${s.file}|${s.symbol}|${s.edgeKind ?? s.edge_kind}|${s.provenance}`).join("\n");
const serTrunc = (xs: any[]) =>
  xs.map((t) => `${t.kind}|${t.value}|${t.scanned}|${t.total}|${t.reason}`).join("\n");

let ok = 0, bad = 0, nonTrivial = 0;
const fails: string[] = [];
const t0 = Date.now();

for (const [i, d] of anchors.entries()) {
  const ctx = new EngineCtx();
  const ts = await couplingOtherSides(repo, d.file, d.name, { llm: false }, ctx);
  const rust = addon.couplingOtherSides(repo, d.file, d.name);
  if (ts.length || rust.sides.length) nonTrivial++;
  for (const [tag, a, b] of [
    ["sides", serSides(ts), serSides(rust.sides)],
    ["trunc", serTrunc(ctx.couplingTruncations), serTrunc(rust.truncations)],
  ] as [string, string, string][]) {
    if (a === b) { ok++; continue; }
    bad++;
    if (fails.length < 8) {
      const al = a.split("\n"), bl = b.split("\n");
      const k = al.findIndex((l, j) => l !== bl[j]);
      fails.push(`✗ ${tag} ${d.file}#${d.name}\n  ts  [${al.length}]: ${al[k] ?? "<none>"}\n  rust[${bl.length}]: ${bl[k] ?? "<none>"}`);
    }
  }
  process.stderr.write(`\r[${i + 1}/${anchors.length} ${Math.round((Date.now() - t0) / 1000)}s ok=${ok} bad=${bad}]`);
}

process.stderr.write("\n");
console.log(`\ncoupling_other_sides parity over ${repo}`);
console.log(`  anchors: ${anchors.length}   with a crossing or truncation: ${nonTrivial}`);
console.log(`  byte-identical: ${ok}   mismatches: ${bad}`);
for (const f of fails) console.log(f);
process.exit(bad ? 1 : 0);
