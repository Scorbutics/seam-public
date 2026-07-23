// PERF baseline — time the Rust grow at the 3 caching levels, both in-process (long-lived, MCP/extension
// scenario) and the disk state the caller controls (fresh-process scenario via rm .seam/rust externally).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
// centers: A, then A again (warm), then B (NEAR — shares footprint files with A)
const A = { file: process.argv[3], symbol: process.argv[4] };
const B = { file: process.argv[5] ?? A.file, symbol: process.argv[6] ?? A.symbol };
const dc = (process.argv[7] ?? "true") === "true";
const MAX_STEPS = 12, MAX_NODES = 80;

const t = (label: string, fn: () => any): any => {
  const t0 = performance.now();
  const r = fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(28)} ${(ms / 1000).toFixed(2)}s  nodes=${r?.nodes?.length ?? "-"}`);
  return r;
};

console.log(`repo=${repo} dc=${dc}\nA=${A.file}#${A.symbol}\nB=${B.file}#${B.symbol}\n`);
// 1) first grow of A in this process — in-memory caches COLD (index rebuild if grow-v1 misses on disk)
t("A #1 (in-mem cold)", () => addon.growToTerminals(repo, A.file, A.symbol, dc, MAX_STEPS, MAX_NODES));
// 2) grow A again — grow-v1 warm (in-mem + disk)
t("A #2 (warm same-center)", () => addon.growToTerminals(repo, A.file, A.symbol, dc, MAX_STEPS, MAX_NODES));
// 3) grow NEAR center B — index now warm in-mem; grow-v1 for B may miss → shares footprint/index
t("B (near, index warm)", () => addon.growToTerminals(repo, B.file, B.symbol, dc, MAX_STEPS, MAX_NODES));
// 4) grow B again — warm
t("B #2 (warm)", () => addon.growToTerminals(repo, B.file, B.symbol, dc, MAX_STEPS, MAX_NODES));
