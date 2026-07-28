// Differential: Rust extract_atoms vs the TS oracle, over every function-shaped unit of a real corpus.
import { extract_atoms, lang_for, available } from "/home/scorbutics/seam-phase0/ts/src/codebase/atoms.js";
import { loadAddon } from "/home/scorbutics/seam-phase0/ts/src/codebase/rust_core.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
const addon = loadAddon();
if (!available()) { console.log("no tree-sitter"); process.exit(0); }
const files: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d)) { if (e === "node_modules" || e === ".git" || e === "target") continue; const p = join(d, e); const st = statSync(p); if (st.isDirectory()) walk(p); else if (/\.(ts|js|java|rb|py)$/.test(p) && !p.endsWith(".d.ts")) files.push(p); } };
for (const root of process.argv.slice(2)) walk(root);
let ok = 0, bad = 0, nonEmpty = 0; const fails: string[] = [];
for (const f of files) {
  const text = readFileSync(f, "utf-8");
  const lang = lang_for(f); if (!lang) continue;
  const lines = text.split("\n").length;
  // probe a spread of anchor windows across the file
  for (let s = 0; s < lines; s += 3) {
    const e = Math.min(lines - 1, s + 60);
    const tsA = (await extract_atoms(text, lang, s, e)).map((a: any) => [a.start, a.end, [...a.names].sort()]);
    const rsRows = (addon.extractAtoms(text, lang, s, e) as string[][]).map((r) => [Number(r[0]), Number(r[1]), r.slice(2).sort()]);
    if (tsA.length) nonEmpty++;
    const a = JSON.stringify(tsA), b = JSON.stringify(rsRows);
    if (a === b) ok++; else { bad++; if (fails.length < 4) fails.push(`${f}@${s}\n  TS: ${a.slice(0, 300)}\n  RS: ${b.slice(0, 300)}`); }
  }
}
console.log(`atoms parity: ${ok} ok / ${bad} bad   (non-empty ${nonEmpty}, files ${files.length})`);
for (const x of fails) console.log(x);
