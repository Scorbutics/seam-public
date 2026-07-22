// Byte-identical harness (G3) — Rust phase_seed vs TS _phaseSeed (replicated from exported build_footprint +
// merge_resolved + the default exclusion prune). The P1 structural seed: pruned UP ⊕ DOWN (backward-tagged).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { build_footprint } from "../../ts/src/codebase/scan/footprint.js";
import { merge_resolved } from "../../ts/src/codebase/scan/expand.js";
import { isTestFile } from "../../ts/src/core/resolve/consumers.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "80", 10);
const glob = process.argv[4] ?? "*.java";
const kindWanted = process.argv[5] ?? "method";
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", glob], { maxBuffer: 512 * 1024 * 1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);

const excludedFile = (f?: string) => !!f && isTestFile(f.replace(/\\/g, "/"));
const prune = (g: any) => {
  if (!g?.nodes?.length) return g;
  const drop = new Set<string>(g.nodes.filter((n: any) => n.id !== "n1" && excludedFile(n.file)).map((n: any) => n.id));
  if (!drop.size) return g;
  return { ...g, nodes: g.nodes.filter((n: any) => !drop.has(n.id)), edges: (g.edges ?? []).filter((e: any) => !drop.has(e.from) && !drop.has(e.to)) };
};

const cand = (c: any) => `${c.symbol ?? ""}:${c.file ?? ""}:${c.provenance ?? ""}`;
const ser = (g: any) => {
  const n = (x: any) => `N ${x.id}|${x.symbol}|${x.kind}|${x.file}|${x.range[0]},${x.range[1]}|${x.enclosing}|${x.complexity}|${x.coupling ? 1 : 0}|${x.direction ?? ""}`;
  const e = (x: any) => `E ${x.from}->${x.to}|${x.kind}|${x.provenance}|${x.line ?? ""}|${x.op ?? ""}`;
  const b = (x: any) => `B ${x.node}|${x.mechanism}|${x.evidence}|${(x.candidates ?? []).map(cand).join(",")}|${x.persists ? 1 : 0}`;
  const aid = g.anchor?.id ?? g.anchorId, arange = g.anchor?.range ?? g.anchorRange;
  return [`A ${aid}|${g.anchor?.symbol ?? g.anchorSymbol}|${g.anchor?.file ?? g.anchorFile}|${arange.join(",")}|${g.language}`,
    ...g.nodes.map(n), ...g.edges.map(e), ...(g.blindspots ?? []).map(b), `ANCHORS ${(g.anchors ?? []).join(",")}`].join("\n");
};

const tsSeed = async (file: string, symbol: string, ctx: EngineCtx) => {
  const up = prune(await build_footprint(repo, file, symbol, { direction: "up", dataCoupling: false, llm: false, ctx }));
  const down = prune(await build_footprint(repo, file, symbol, { direction: "down", dataCoupling: false, llm: false, ctx }));
  for (const nd of down.nodes) if (nd.id !== down.anchor?.id && !nd.direction) nd.direction = "backward";
  return merge_resolved(up, down, down.anchor?.id);
};

const lang = glob.includes(".ts") ? "typescript" : "java";
const ctx = new EngineCtx();
let ok = 0, bad = 0, ne = 0; const fails: string[] = [];
for (let i = 0; i < files.length; i++) {
  const file = files[i]; const text = readFileSync(`${repo}/${file}`, "utf8"); if (!/^[\x00-\x7F]*$/.test(text)) continue;
  const units = addon.namedUnits(text, lang) as any[];
  const u = units.find((x) => x.kind === kindWanted); if (!u) continue;
  let ts: any; try { ts = await tsSeed(file, u.name, ctx); } catch { continue; }
  if (!ts || !ts.nodes.length) continue;
  const rust = addon.growSeed(repo, file, u.name);
  if (!rust) { bad++; continue; }
  if (ts.nodes.length > 1) ne++;
  if (ser(ts) === ser(rust)) ok++;
  else { bad++; if (fails.length < 12) { const tl = ser(ts).split("\n"), rl = ser(rust).split("\n"); const k = tl.findIndex((l, j) => l !== rl[j]); fails.push(`✗ ${file}#${u.name}\n  ts:   ${tl[k] ?? "<none>"}\n  rust: ${rl[k] ?? "<none>"}`); } }
}
console.log(`\nphase_seed parity over ${glob} [${kindWanted}]: ${ok} ok / ${bad} bad (non-trivial ${ne})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
