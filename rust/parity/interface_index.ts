// Byte-identical harness — Rust InterfaceIndex vs TS interface_index: impls_of over a large candidate name
// set (every `interface X` / `class X` declared in the repo) + the whole provider_accessors map.
//   bun rust/parity/interface_index.ts [repo] [maxNames]
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { impls_of, provider_accessors } from "../../ts/src/codebase/scan/down/interface_index.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxNames = parseInt(process.argv[3] ?? "4000", 10);

// candidate names: everything declared as an interface OR class across the repo (Java+TS). Non-interfaces
// must resolve to [] on both sides — so this also checks the "never chase a concrete class" guard.
const decls = execFileSync("bash", ["-c",
  `cd ${repo} && git grep -hoE '\\b(interface|class)\\s+[A-Za-z_$][A-Za-z0-9_$]*' -- '*.java' '*.ts' '*.tsx' 2>/dev/null | sed -E 's/.*\\s+//' | sort -u`],
  { maxBuffer: 512 * 1024 * 1024 }).toString().split("\n").filter(Boolean).slice(0, maxNames);

const t0 = Date.now();
console.log(`querying impls_of for ${decls.length} candidate names…`);

// Rust: one batched call (index built once)
const rustImpls: string[][][] = addon.implsOfBatch(repo, decls);
const rustAcc: string[][] = addon.providerAccessors(repo);

const serImpls = (rows: any[]) => rows.map((r: any) => Array.isArray(r) ? `${r[0]}|${r[1]}` : `${r.cls}|${r.file}`).join(";");

let ok = 0, bad = 0, nonEmpty = 0;
const fails: string[] = [];
for (let i = 0; i < decls.length; i++) {
  const ts = await impls_of(repo, decls[i]);
  const t = serImpls(ts), r = serImpls(rustImpls[i]);
  if (ts.length) nonEmpty++;
  if (t === r) ok++; else { bad++; if (fails.length < 12) fails.push(`✗ ${decls[i]}\n    ts:   ${t}\n    rust: ${r}`); }
}

// provider_accessors: compare full map
const tsAcc = await provider_accessors(repo);
const tsAccRows = [...tsAcc.entries()].map(([m, ifs]) => `${m}:${[...ifs].sort().join(",")}`).sort();
const rustAccRows = rustAcc.map((row) => `${row[0]}:${row.slice(1).join(",")}`).sort();
const accOk = JSON.stringify(tsAccRows) === JSON.stringify(rustAccRows);

console.log(`\ninterface_index parity over ${repo}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
console.log(`  impls_of: ${ok} ok / ${bad} bad   (non-empty: ${nonEmpty} of ${decls.length})`);
console.log(`  provider_accessors: ${accOk ? "IDENTICAL" : "DIFFER"} (ts ${tsAccRows.length} rows, rust ${rustAccRows.length} rows)`);
if (fails.length) console.log("\n" + fails.join("\n"));
if (!accOk) { const d = tsAccRows.findIndex((r, i) => r !== rustAccRows[i]); console.log(`  acc first diff:\n    ts:   ${tsAccRows[d] ?? "<none>"}\n    rust: ${rustAccRows[d] ?? "<none>"}`); }
process.exit(bad || !accOk ? 1 : 0);
