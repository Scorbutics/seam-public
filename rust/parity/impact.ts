// Byte-identical harness — Rust project_impact vs TS projectImpact (STRUCTURAL closure: dataCoupling OFF,
// couplingOverlay OFF). Anchor = (java file, its class) + a method. Compares the whole shape: impacted (hop-
// sorted, localeCompare tiebreak), files rollup, surface, gaps, total/fileCount/hops/truncated/noStructure.
//   bun rust/parity/impact.ts [repo] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { projectImpact } from "../../ts/src/codebase/grow/impact.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "60", 10);

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString().split("\0").filter(Boolean).slice(0, maxFiles);
const classOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1, -5);

const ser = (g: any) => {
  const sym = (x: any) => `${x.symbol}|${x.file}|${x.line}|${x.kind}|${x.hop}`;
  return [
    `A ${g.anchorSymbol ?? g.anchor?.symbol}|${g.anchorFile ?? g.anchor?.file}`,
    `TOTAL ${g.total} FILES ${g.fileCount ?? g.file_count} HOPS ${g.hops} TRUNC ${g.truncated ? 1 : 0} NOSTRUCT ${(g.noStructure ?? g.no_structure) ? 1 : 0} REASON ${g.reason ?? ""}`,
    ...g.impacted.map((x: any) => `I ${sym(x)}`),
    ...g.files.map((f: any) => `F ${f.file}|${f.count}`),
    ...g.surface.map((x: any) => `S ${sym(x)}`),
    ...g.gaps.map((x: any) => `G ${x.mechanism}|${x.evidence}`),
  ].join("\n");
};

let ok = 0, bad = 0, nonTrivial = 0;
const fails: string[] = [];
const t0 = Date.now();

async function check(file: string, symbol: string) {
  const ts = await projectImpact(repo, file, symbol, { dataCoupling: false, couplingOverlay: false });
  const rust = addon.projectImpact(repo, file, symbol, null, null);
  if (ts.total > 0) nonTrivial++;
  const t = ser(ts), r = ser(rust);
  if (t === r) { ok++; return; }
  bad++;
  if (fails.length < 15) {
    const tl = t.split("\n"), rl = r.split("\n");
    const k = tl.findIndex((l, j) => l !== rl[j]);
    fails.push(`✗ ${file}#${symbol}\n    ts:   ${tl[k] ?? "<none>"}\n    rust: ${rl[k] ?? "<none>"}`);
  }
}

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  process.stdout.write(`[${i + 1}/${files.length} ${((Date.now() - t0) / 1000).toFixed(0)}s ok=${ok} bad=${bad}] ${file}\n`);
  const units = addon.namedUnits(readFileSync(`${repo}/${file}`, "utf8"), "java") as any[];
  await check(file, classOf(file));
  const method = units.find((u) => u.kind === "method");
  if (method) await check(file, method.name);
}

console.log(`\nproject_impact parity over ${repo}`);
console.log(`  anchors: ${ok + bad}   non-trivial (impact found): ${nonTrivial}`);
console.log(`  byte-identical: ${ok}   mismatches: ${bad}`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
