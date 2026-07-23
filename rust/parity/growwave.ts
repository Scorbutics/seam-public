// Byte-identical harness (G5) — Rust grow_to_terminals vs TS grow_to_terminals (structuralGrow:true,
// SEAM_PARALLEL_GROW=0). Default dataCoupling:false isolates the STRUCTURAL WAVE (_phaseExpand); pass "1" as
// arg 6 to also run the coupling overlay. Compares the grown node/edge/blindspot/anchor set (hub markers +
// frontier are additive annotations the ser doesn't read yet).
process.env.SEAM_PARALLEL_GROW = "0";
process.env.SEAM_GRAPH_CACHE = "0"; // compare pure-compute vs pure-compute (TS build_footprint_cached conflates same-name symbols)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { grow_to_terminals } from "../../ts/src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "15", 10);
const glob = process.argv[4] ?? "*.java";
const kindWanted = process.argv[5] ?? "method";
const dc = process.argv[6] === "1";
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", glob], { maxBuffer: 512 * 1024 * 1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);

const cand = (c: any) => `${c.symbol ?? ""}:${c.file ?? ""}:${c.provenance ?? ""}`;
const ser = (g: any) => {
  const n = (x: any) => `N ${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}|${x.coupling ? 1 : 0}|${x.direction ?? ""}`;
  const e = (x: any) => `E ${x.kind}|${x.provenance}|${x.line ?? ""}|${x.op ?? ""}`;
  const b = (x: any) => `B ${x.mechanism}|${x.evidence}|${(x.candidates ?? []).map(cand).join(",")}|${x.persists ? 1 : 0}`;
  // sort by content (id assignment is transient across pool/sequential paths; the grown SET is the contract).
  return [
    "NODES", ...g.nodes.map(n).sort(),
    "EDGES", ...g.edges.map((x: any) => `${g.nodes.find((k: any) => k.id === x.from) ? n(g.nodes.find((k: any) => k.id === x.from)) : x.from} ==> ${g.nodes.find((k: any) => k.id === x.to) ? n(g.nodes.find((k: any) => k.id === x.to)) : x.to} | ${e(x)}`).sort(),
    "BLIND", ...(g.blindspots ?? []).map(b).sort(),
  ].join("\n");
};

const lang = glob.includes(".ts") ? "typescript" : "java";
let ok = 0, bad = 0, ne = 0; const fails: string[] = [];
for (let i = 0; i < files.length; i++) {
  const file = files[i]; const text = readFileSync(`${repo}/${file}`, "utf8"); if (!/^[\x00-\x7F]*$/.test(text)) continue;
  const units = addon.namedUnits(text, lang) as any[];
  const u = units.find((x) => x.kind === kindWanted); if (!u) continue;
  let ts: any; try { [ts] = await grow_to_terminals(repo, file, u.name, { structuralGrow: true, dataCoupling: dc, dataCouplingLlm: false, maxNodes: 80, ctx: new EngineCtx() } as any); } catch (err) { continue; }
  if (!ts || ts.nodes.length <= 1) continue;
  ne++;
  const rust = addon.growToTerminals(repo, file, u.name, dc, 12, 80);
  if (!rust) { bad++; if (fails.length < 10) fails.push(`✗ ${file}#${u.name} — rust null`); continue; }
  const ts2 = ser(ts), r2 = ser(rust);
  if (ts2 === r2) ok++;
  else { bad++; if (fails.length < 10) { const tl = ts2.split("\n"), rl = r2.split("\n"); const k = tl.findIndex((l, j) => l !== rl[j]); fails.push(`✗ ${file}#${u.name} (ts ${ts.nodes.length}n/${tl.length}L vs rust ${rust.nodes.length}n/${rl.length}L)\n  ts:   ${tl[k] ?? "<none>"}\n  rust: ${rl[k] ?? "<none>"}`); } }
}
console.log(`\ngrow_to_terminals parity over ${glob} [${kindWanted}] dataCoupling:${dc}: ${ok} ok / ${bad} bad (non-trivial ${ne})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
