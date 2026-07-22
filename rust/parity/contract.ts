// Byte-identical harness — Rust project_contract vs TS projectContract. Anchor = a whole Java file (module).
// Compares provides (used exports + consumers), unusedExports, depends (external imports), afferent/efferent.
//   bun rust/parity/contract.ts [repo] [maxFiles]
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { projectContract } from "../../ts/src/codebase/grow/contract.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "200", 10);

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString().split("\0").filter(Boolean).slice(0, maxFiles);

const ser = (c: any) => {
  const prov = (p: any) => `P ${p.symbol}|${p.kind}|${p.consumerCount ?? p.consumer_count}|${p.consumers.map((x: any) => `${x.file}:${x.symbol}`).join(";")}`;
  const dep = (d: any) => `D ${d.symbol}|${d.source}|${d.file}`;
  return [
    `M ${c.module} aff=${c.afferent} eff=${c.efferent} nostruct=${(c.noStructure ?? c.no_structure) ? 1 : 0} reason=${c.reason ?? ""}`,
    ...c.provides.map(prov),
    `U ${c.unusedExports.join(",") ?? (c.unused_exports ?? []).join(",")}`,
    ...c.depends.map(dep),
  ].join("\n");
};

let ok = 0, bad = 0, nonTrivial = 0;
const fails: string[] = [];
const t0 = Date.now();

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  process.stdout.write(`[${i + 1}/${files.length} ${((Date.now() - t0) / 1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  const ts = await projectContract(repo, file);
  const rust = addon.projectContract(repo, file);
  if (ts.provides.length || ts.depends.length) nonTrivial++;
  const t = ser(ts), r = ser(rust);
  if (t === r) { ok++; continue; }
  bad++;
  if (fails.length < 15) {
    const tl = t.split("\n"), rl = r.split("\n");
    const k = tl.findIndex((l, j) => l !== rl[j]);
    fails.push(`✗ ${file}\n    ts:   ${tl[k] ?? "<none>"}\n    rust: ${rl[k] ?? "<none>"}`);
  }
}

console.log(`\nproject_contract parity over ${repo}`);
console.log(`  contracts: ${ok + bad}   non-trivial: ${nonTrivial}`);
console.log(`  byte-identical: ${ok}   mismatches: ${bad}`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
