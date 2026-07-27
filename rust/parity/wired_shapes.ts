// STEP-4 WIRING GATE — the RENDERED answer must be identical whichever engine served it.
//
// Every other comparator in rust/parity pins a projection. This one pins what the USER actually receives: the
// same CLI invocation is run twice, once with the Rust core enabled and once forced onto TS, and the two
// outputs are compared byte for byte. That is the contract a routing decision has to meet — a shape may only
// flip when the answer does not change, and the projection being identical is necessary but not sufficient
// (the model→render adapter is where a wired shape actually breaks: a missing `anchor`, an emitted falsy
// `noStructure`, a dropped `recalled`).
//
//   bun rust/parity/wired_shapes.ts [repo] [maxAnchors]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/cal.com";
const maxAnchors = parseInt(process.argv[3] ?? "8", 10);
const CLI = "/home/scorbutics/seam-phase0/ts/src/cli/decompose.ts";
// Every shape that routes to Rust, in the configuration it is ROUTED in. All but `neighborhood` run in their
// DEFAULT (coupling ON) configuration, since the coupling overlay, the reach hops and the learned per-file keys
// all live in the core now. `reaches` is covered by rust/parity/reach.ts instead: this harness drives the CLI,
// which needs a --to-symbol pair.
const WIRED: { q: string; extra?: string[] }[] = [
  { q: "consumers" }, { q: "dependencies" }, { q: "contract" }, { q: "writers" }, { q: "coupling" },
  { q: "impact" }, { q: "refactor" },
  // the one shape still gated (a residual coupling edge in the ball) — exercised in its ROUTED configuration
  { q: "neighborhood", extra: ["--no-data-coupling"] },
];

const defs = (addon.enumerateDefs(repo, 200000, undefined, false) as any[])
  .filter((d) => /\.(ts|tsx)$/.test(d.file) && ["function", "method"].includes(d.kind) && d.name);
const step = Math.max(1, Math.floor(defs.length / maxAnchors));
const anchors = defs.filter((_, i) => i % step === 0).slice(0, maxAnchors);

const run = (query: string, center: string, engine: "0" | "1", extra: string[] = []): string => {
  try {
    return execFileSync("bun", [CLI, "--scan", "--repo", repo, "--query", query, "--center", center, "--format", "llm-context", ...extra],
      { env: { ...process.env, SEAM_RUST_CORE: engine }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });
  } catch (e: any) { return `ERROR ${String(e?.status ?? e).slice(0, 120)}`; }
};

let ok = 0, bad = 0, nonTrivial = 0;
const fails: string[] = [];
const t0 = Date.now();
for (const [i, d] of anchors.entries()) {
  const center = `${d.file}#${d.name}`;
  for (const { q, extra } of WIRED) {
    const ts = run(q, center, "0", extra), rust = run(q, center, "1", extra);
    if (/resolved: [1-9]|impacted: [1-9]|provides: [1-9]|members: [1-9]|shared key/.test(ts)) nonTrivial++;
    if (ts === rust) { ok++; continue; }
    bad++;
    if (fails.length < 6) {
      const [a, b] = [ts.split("\n"), rust.split("\n")];
      const k = a.findIndex((l, j) => l !== b[j]);
      fails.push(`✗ ${q} ${center}\n  ts:   ${(a[k] ?? "<none>").slice(0, 150)}\n  rust: ${(b[k] ?? "<none>").slice(0, 150)}`);
    }
  }
  process.stderr.write(`\r[${i + 1}/${anchors.length} ${Math.round((Date.now() - t0) / 1000)}s ok=${ok} bad=${bad}]`);
}
process.stderr.write("\n");

console.log(`\nwired-shape render parity over ${repo}  (${WIRED.map((w) => w.q).join(", ")})`);
console.log(`  anchors: ${anchors.length}   renders compared: ${ok + bad}   with a resolved member: ${nonTrivial}`);
console.log(`  byte-identical: ${ok}   mismatches: ${bad}`);
for (const f of fails) console.log(f);
if (!nonTrivial) { console.log("  REFUSING to pass: every anchor rendered an empty answer — this proved nothing."); process.exit(2); }
process.exit(bad ? 1 : 0);
