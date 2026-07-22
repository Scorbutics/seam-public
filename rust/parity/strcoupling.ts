import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { module_entry_index, detect } from "../../ts/src/codebase/scan/down/string_coupling.js";
import { makeCtx } from "../../ts/src/codebase/atoms.js";
import { SKIP_DIRS } from "../../ts/src/core/resolve/languages/index.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "300", 10);

// 1) module_entry_index — compare the whole map
const tsIdx = module_entry_index(repo, SKIP_DIRS);
const tsRows = [...tsIdx.entries()].map(([k, fs]) => `${k}|${fs.join(",")}`).sort();
const rustRows = (addon.moduleEntryIndex(repo) as string[][]).map((r) => `${r[0]}|${r.slice(1).join(",")}`).sort();
const idxOk = JSON.stringify(tsRows) === JSON.stringify(rustRows);
console.log(`module_entry_index: ${idxOk ? "IDENTICAL" : "DIFFER"} (ts ${tsRows.length} rows, rust ${rustRows.length})`);
if (!idxOk) { const d = tsRows.findIndex((r, i) => r !== rustRows[i]); console.log(`  first diff:\n    ts:   ${tsRows[d] ?? "<none>"}\n    rust: ${rustRows[d] ?? "<none>"}`); }

// 2) detect over Java anchors (whole-file span)
const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512*1024*1024 }).toString().split("\0").filter(Boolean).slice(0, maxFiles);
let ok=0,bad=0,nonEmpty=0; const fails:string[]=[];
for (const rel of files) {
  let text: string; try { text = readFileSync(`${repo}/${rel}`, "utf8"); } catch { continue; }
  if (!/^[\x00-\x7F]*$/.test(text)) continue;
  const ctx = (await makeCtx(text, "java"))!;
  const mlen = (text.match(/\n/g) ?? []).length;
  const [edges] = detect(ctx, 0, mlen, tsIdx, rel);
  const ts = edges.map((e:any) => `${e[0]}|${e[1]}|${e[2]}`).join(";");
  const rust = (addon.stringDispatch(repo, rel, text, "java") as string[][]).map((r) => r.join("|")).join(";");
  if (edges.length) nonEmpty++;
  if (ts === rust) ok++; else { bad++; if(fails.length<10) fails.push(`✗ ${rel}\n  ts:   ${ts}\n  rust: ${rust}`); }
}
console.log(`detect (java anchors): ${ok} ok / ${bad} bad (non-empty: ${nonEmpty})`);
if(fails.length) console.log(fails.join("\n"));
process.exit(!idxOk || bad ? 1 : 0);
