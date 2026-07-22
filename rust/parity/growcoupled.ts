// Byte-identical harness (G4) — Rust phase_seed ⊕ phase_coupling (+ deep fan) vs TS grow_to_terminals with
// maxNodes:1 (which runs P1 seed → P3 coupling → 0-wave expand → deep-couple), i.e. seed + coupling, no wave.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { grow_to_terminals } from "../../ts/src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "60", 10);
const glob = process.argv[4] ?? "*.java";
const kindWanted = process.argv[5] ?? "method";
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", glob], { maxBuffer: 512 * 1024 * 1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);

// Force TS sequential coupling (no worker pool): the pool's _renumberCoupleDelta mints `dc{n}` ids where the
// sequential path mints `fc{n}` — a transient raw-id difference normalized away in rendering. The Rust core is
// sequential, so the sequential TS path is the byte-identical baseline.
process.env.SEAM_PARALLEL_GROW = "0";

// The maxNodes:1 oracle runs a 0-wave _phaseExpand, which still appends a `flood-safety-cap` blindspot
// (nodes.length >= maxNodes). That's a WAVE artifact, out of scope for seed+coupling — strip it.
const stripWaveArtifacts = (g: any) => { g.blindspots = (g.blindspots ?? []).filter((b: any) => b.mechanism !== "flood-safety-cap"); return g; };

const cand = (c: any) => `${c.symbol ?? ""}:${c.file ?? ""}:${c.provenance ?? ""}`;
const ser = (g: any) => {
  const n = (x: any) => `N ${x.id}|${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}|${x.coupling ? 1 : 0}|${x.direction ?? ""}`;
  const e = (x: any) => `E ${x.from}->${x.to}|${x.kind}|${x.provenance}|${x.line ?? ""}|${x.op ?? ""}`;
  const b = (x: any) => `B ${x.node}|${x.mechanism}|${x.evidence}|${(x.candidates ?? []).map(cand).join(",")}|${x.persists ? 1 : 0}`;
  const aid = g.anchor?.id ?? g.anchorId, arange = g.anchor?.range ?? g.anchorRange;
  return [`A ${aid}|${g.anchor?.symbol ?? g.anchorSymbol}|${g.anchor?.file ?? g.anchorFile}|${arange.join(",")}|${g.language}`,
    ...g.nodes.map(n), ...g.edges.map(e), ...(g.blindspots ?? []).map(b), `ANCHORS ${(g.anchors ?? []).join(",")}`].join("\n");
};

const lang = glob.includes(".ts") ? "typescript" : "java";
let ok = 0, bad = 0, ne = 0, cp = 0; const fails: string[] = [];
for (let i = 0; i < files.length; i++) {
  const file = files[i]; const text = readFileSync(`${repo}/${file}`, "utf8"); if (!/^[\x00-\x7F]*$/.test(text)) continue;
  const units = addon.namedUnits(text, lang) as any[];
  const u = units.find((x) => x.kind === kindWanted); if (!u) continue;
  const ctx = new EngineCtx();
  let ts: any; try { [ts] = await grow_to_terminals(repo, file, u.name, { maxNodes: 1, dataCoupling: true, dataCouplingLlm: false, ctx } as any); } catch { continue; }
  if (!ts || !ts.nodes.length) continue;
  stripWaveArtifacts(ts);
  const rust = addon.growSeedCoupled(repo, file, u.name, false);
  if (!rust) { bad++; continue; }
  if (ts.nodes.length > 1) ne++;
  if (ts.nodes.some((x: any) => x.coupling)) cp++;
  if (ser(ts) === ser(rust)) ok++;
  else { bad++; if (fails.length < 10) { const tl = ser(ts).split("\n"), rl = ser(rust).split("\n"); const k = tl.findIndex((l, j) => l !== rl[j]); fails.push(`✗ ${file}#${u.name}  (ts ${tl.length} / rust ${rl.length} lines)\n  ts:   ${tl[k] ?? "<none>"}\n  rust: ${rl[k] ?? "<none>"}`); } }
}
console.log(`\nphase_seed+coupling parity over ${glob} [${kindWanted}]: ${ok} ok / ${bad} bad (non-trivial ${ne}, with-coupling ${cp})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
