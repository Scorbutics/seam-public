// KEY_CLUSTER parity harness (Phase 2) — TS clusterBlindFiles vs the Rust addon's cluster_blind_files.
// Feeds a sample of repo source files to BOTH and compares the clustering (signature, shaped, rep-index,
// member-indices, and order). The clustering is deterministic + structural (no LLM), so it must be byte-identical.
//
//   bun rust/parity/keycluster.ts [repo] [maxFiles]

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { clusterBlindFiles } from "../../ts/src/codebase/coupling/key_cluster.js";

const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "1500", 10);

// A sample of source files (relpath + text). Use the addon's source_files for an identical file list.
const ext = process.argv[4] ?? ".java";
const rels: string[] = (addon.sourceFiles(repo, ext) as string[]).slice(0, maxFiles);
const files = rels.map((rel) => {
  try { return { file: rel, text: readFileSync(`${repo}/${rel}`, "utf8") }; } catch { return null; }
}).filter(Boolean) as { file: string; text: string }[];

const ts = await clusterBlindFiles(files, repo);
const rust = addon.clusterBlindFiles(files.map((f) => [f.file, f.text]));

// Normalise to signature|shaped|rep-file|sorted-member-files. TS returns file OBJECTS; Rust returns INDICES.
const keyTs = (c: any) => `${c.signature}|${c.shaped ? 1 : 0}|${c.rep.file}|[${c.members.map((m: any) => m.file).sort().join(",")}]`;
const keyRs = (c: any) => `${c.signature}|${c.shaped ? 1 : 0}|${files[c.rep].file}|[${c.members.map((i: number) => files[i].file).sort().join(",")}]`;
const tk = ts.map(keyTs), rk = rust.map(keyRs);

let firstDiff = -1;
for (let i = 0; i < Math.max(tk.length, rk.length); i++) if (tk[i] !== rk[i]) { firstDiff = i; break; }

const tset = new Set(tk), rset = new Set(rk);
const onlyTs = [...tset].filter((k) => !rset.has(k));
const onlyRust = [...rset].filter((k) => !tset.has(k));

console.log(`key_cluster parity over ${repo} (${files.length} files)`);
console.log(`  clusters: TS=${ts.length} Rust=${rust.length} | order-identical=${firstDiff === -1} (first diff idx ${firstDiff})`);
console.log(`  set diff: only-TS=${onlyTs.length} only-Rust=${onlyRust.length}`);
if (firstDiff >= 0) {
  console.log(`  TS  [${firstDiff}]: ${tk[firstDiff]}`);
  console.log(`  Rust[${firstDiff}]: ${rk[firstDiff]}`);
}
if (onlyTs.length) console.log("  only-TS sample:", onlyTs.slice(0, 4));
if (onlyRust.length) console.log("  only-Rust sample:", onlyRust.slice(0, 4));

const ok = firstDiff === -1 && onlyTs.length === 0 && onlyRust.length === 0;
console.log(`  RESULT: ${ok ? "byte-identical OK" : "DIFF"}`);
process.exit(ok ? 0 : 1);
