// Transparency + perf check for the coupling-fan disk cache: cache-OFF == cache-ON-cold == cache-ON-warm,
// AND time each. Must be byte-identical (the fp-hash key makes it transparent).
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const file = process.argv[3];
const sym = process.argv[4];

const ser = (g: any) => {
  const nodes = (g?.nodes ?? []).map((n: any) => `${n.symbol}|${n.file}|${n.kind}|${(n.range ?? [0, 0]).join(",")}|${n.coupling ?? false}`).sort();
  const edges = (g?.edges ?? []).map((e: any) => `${e.kind}|${e.provenance}|${e.line ?? ""}`).sort();
  return `n${nodes.length}\n${nodes.join("\n")}\ne${edges.length}\n${edges.join("\n")}`;
};
const timeGrow = (): [string, number] => {
  const t0 = performance.now();
  const g = addon.growToTerminals(repo, file, sym, true, 12, 80);
  return [ser(g), (performance.now() - t0) / 1000];
};

// 1) cache-OFF (the oracle) — must match everything
process.env.SEAM_GRAPH_CACHE = "0";
const [off] = timeGrow();
// 2) cache-ON cold (fresh coupling-fan shards): reset in-mem + rm the fan shards
delete process.env.SEAM_GRAPH_CACHE;
try { execSync(`rm -rf ${repo}/.seam/rust/coupling-fan-v1 ${repo}/.seam/rust/grow-v1`); } catch {}
addon.resetCaches(repo);
const [coldStr, coldT] = timeGrow();
// 3) cache-ON warm (fan shards present): reset in-mem only (grow-v1 also rm'd so the fan cache is exercised)
try { execSync(`rm -rf ${repo}/.seam/rust/grow-v1`); } catch {}
addon.resetCaches(repo);
const [warmStr, warmT] = timeGrow();

console.log(`center ${sym}`);
console.log(`cache-OFF == cold : ${off === coldStr ? "OK" : "MISMATCH"}`);
console.log(`cache-OFF == warm : ${off === warmStr ? "OK" : "MISMATCH"}`);
console.log(`timings: cold(compute+save)=${coldT.toFixed(2)}s  warm(fan-load)=${warmT.toFixed(2)}s`);
if (off !== warmStr) {
  const a = off.split("\n"), b = warmStr.split("\n");
  const k = a.findIndex((l, i) => l !== b[i]);
  console.log(`first diff @${k}:\n off:  ${a[k]}\n warm: ${b[k]}`);
}
