// DIFFERENTIAL: Rust `extract_contract` vs the TypeScript oracle.
//
// The contract is where the anchor meets everything outside it, so a drift here is a drift in what the whole
// decompose says a unit DEPENDS ON. Three rules can each go wrong silently: a typed param's TYPE must not be
// mistaken for its name (`x: Foo` — the last identifier wins, not the first); a body-destructured param must
// DROP OUT in favour of its fields (`const {a,b} = props` reports a and b, never props); and `invoked` marks a
// collaborator the anchor drives rather than a value it reads.
//
//   bun rust/parity/contract.ts <dir…>
import { extract_contract, lang_for, available } from "../../ts/src/codebase/atoms.js";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const addon = loadAddon();
if (!available() || !addon) { console.log("no tree-sitter / no addon"); process.exit(0); }

const files: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d)) { if (e === "node_modules" || e === ".git" || e === "target") continue; const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|js|java|rb|py)$/.test(p) && !p.endsWith(".d.ts")) files.push(p); } };
for (const root of process.argv.slice(2)) walk(root);

let ok = 0, bad = 0, nonEmpty = 0, invoked = 0, multiRange = 0; const fails: string[] = [];
for (const f of files) {
  const text = readFileSync(f, "utf-8");
  const lang = lang_for(f); if (!lang) continue;
  const lines = text.split("\n").length;
  for (let s = 0; s < lines; s += 3) {
    const e = Math.min(lines - 1, s + 60);
    const ts = (await extract_contract(text, lang, s, e)).map((m: any) => [m.name, m.invoked ? "1" : "", m.ranges.map((r: number[]) => `${r[0]}:${r[1]}`).join(",")]);
    const rs = addon.extractContract(text, lang, s, e) as string[][];
    if (ts.length) { nonEmpty++; if (ts.some((m) => m[1] === "1")) invoked++; if (ts.some((m) => m[2].includes(","))) multiRange++; }
    const a = JSON.stringify(ts), b = JSON.stringify(rs);
    if (a === b) ok++; else { bad++; if (fails.length < 4) fails.push(`${f}@${s}\n  TS: ${a.slice(0, 400)}\n  RS: ${b.slice(0, 400)}`); }
  }
}
console.log(`contract parity: ${ok} ok / ${bad} bad   (non-empty ${nonEmpty}, with-invoked ${invoked}, multi-range ${multiRange}, files ${files.length})`);
for (const x of fails) console.log(x);
