// DIFFERENTIAL: Rust `subcores` vs the TypeScript `detect_subcores` clustering, over a real corpus.
//
// The clustering is where a port goes wrong quietly. Union-find is order-insensitive for CONNECTIVITY but the
// group NUMBERING is not (g1 goes to the first atom's root), the ambient threshold is `>` and not `>=`, and
// the emitted group order is LEXICOGRAPHIC on the id string — so past nine groups it runs g1, g10, g11, g2.
// Any of those three could differ while every hand-written unit test still passed.
//
//   bun rust/parity/subcores.ts <dir…>
import { extract_atoms, lang_for, available } from "../../ts/src/codebase/atoms.js";
import { connected_components } from "../../ts/src/core/graph_ir.js";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const addon = loadAddon();
if (!available() || !addon) { console.log("no tree-sitter / no addon"); process.exit(0); }

// the TS oracle: detect_subcores' pure half, verbatim from detect.ts
function tsSubcores(ats: any[]): any[] {
  if (ats.length < 2) return [];
  const cut = Math.max(1, Math.floor(ats.length / 2));
  const freq = new Map<string, number>();
  for (const a of ats) for (const n of a.names) freq.set(n, (freq.get(n) ?? 0) + 1);
  const ambient = new Set([...freq.entries()].filter(([, c]) => c > cut).map(([n]) => n));
  const ids = ats.map((_, i) => `x.b${i}`);
  const byName = new Map<string, string[]>();
  const edges: [string, string][] = [];
  ats.forEach((a, i) => { for (const name of a.names) if (!ambient.has(name)) { if (!byName.has(name)) byName.set(name, []); byName.get(name)!.push(ids[i]); } });
  for (const members of byName.values()) for (const x of members.slice(1)) edges.push([members[0], x]);
  const groups = connected_components(ids, edges);
  if (new Set(groups.values()).size < 2) return [];
  const byGroup = new Map<string, number[]>();
  ats.forEach((_, i) => { const k = groups.get(ids[i])!; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k)!.push(i); });
  const out: any[] = [];
  for (const gid of [...byGroup.keys()].sort()) {
    const idxs = byGroup.get(gid)!;
    const reads = [...new Set(idxs.flatMap((i) => [...ats[i].names].filter((n: string) => !ambient.has(n))))].sort();
    out.push([gid, reads.length ? reads[0] : gid, idxs.map((i) => `${ats[i].start}:${ats[i].end}`).join(","), ...reads]);
  }
  return out;
}

const files: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d)) { if (e === "node_modules" || e === ".git" || e === "target") continue; const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|js|java|rb|py)$/.test(p) && !p.endsWith(".d.ts")) files.push(p); } };
for (const root of process.argv.slice(2)) walk(root);

let ok = 0, bad = 0, nonEmpty = 0, multi = 0; const fails: string[] = [];
for (const f of files) {
  const text = readFileSync(f, "utf-8");
  const lang = lang_for(f); if (!lang) continue;
  const lines = text.split("\n").length;
  for (let s = 0; s < lines; s += 3) {
    const e = Math.min(lines - 1, s + 60);
    const ats = await extract_atoms(text, lang, s, e);
    const a = JSON.stringify(tsSubcores(ats));
    const b = JSON.stringify(addon.subcoresOf(text, lang, s, e));
    if (a !== "[]") { nonEmpty++; if (JSON.parse(a).length > 1) multi++; }
    if (a === b) ok++; else { bad++; if (fails.length < 4) fails.push(`${f}@${s}\n  TS: ${a.slice(0, 400)}\n  RS: ${b.slice(0, 400)}`); }
  }
}
console.log(`subcores parity: ${ok} ok / ${bad} bad   (non-empty ${nonEmpty}, multi-group ${multi}, files ${files.length})`);
for (const x of fails) console.log(x);
