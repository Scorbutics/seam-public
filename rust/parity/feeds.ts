// DIFFERENTIAL: Rust `extract_consumer_feeds` vs the TypeScript oracle.
//
// Feeds are what a CONSUMER binds into the anchor's parameters — how a reader gets from "this prop exists" to
// "here is what is actually passed, at this line and column". Three shapes have to agree: an expression
// attribute unwraps its braces (the feed reads `user.id`, not the braced form), a string attribute keeps its
// quotes, and a BARE attribute is the string "true" with NO value position — the one case where valLine and
// valCol are absent rather than zero.
//
//   bun rust/parity/feeds.ts <dir...>
import { extract_consumer_feeds, available } from "../../ts/src/codebase/atoms.js";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const addon = loadAddon();
if (!available() || !addon) { console.log("no tree-sitter / no addon"); process.exit(0); }

const files: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    if (e === "node_modules" || e === ".git" || e === "target") continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|jsx|ts|js|java|rb|py)$/.test(p) && !p.endsWith(".d.ts")) files.push(p);
  }
};
for (const root of process.argv.slice(2)) walk(root);

// every capitalised tag in the corpus is a candidate anchor component name
const tagsOf = (t: string): string[] => [...new Set([...t.matchAll(/<([A-Z][\w.]*)/g)].map((m) => m[1]))];

let ok = 0, bad = 0, nonEmpty = 0, bare = 0;
const fails: string[] = [];
for (const f of files) {
  const text = readFileSync(f, "utf-8");
  const names = tagsOf(text);
  for (const name of names.length ? names : ["Anchor"]) {
    const tsFeeds = await extract_consumer_feeds(text, f, name);
    const ts: string[][] = [];
    for (const [prop, binds] of Object.entries(tsFeeds)) {
      for (const b of binds as any[]) {
        ts.push([prop, b.value, String(b.line), "valLine" in b ? String(b.valLine) : "", "valCol" in b ? String(b.valCol) : ""]);
      }
    }
    const rs = addon.extractConsumerFeeds(text, f, name) as string[][];
    // the TS shape is a prop -> list map (grouped per prop); the Rust is a flat source-ordered list, so the
    // comparison is over row MULTISETS — the grouping is a shape difference, not a disagreement about facts
    const norm = (rows: string[][]) => JSON.stringify([...rows].map((r) => r.join("")).sort());
    if (ts.length) { nonEmpty++; if (ts.some((r) => r[1] === "true" && r[3] === "")) bare++; }
    if (norm(ts) === norm(rs)) ok++;
    else { bad++; if (fails.length < 4) fails.push(`${f} <${name}>\n  TS: ${norm(ts).slice(0, 400)}\n  RS: ${norm(rs).slice(0, 400)}`); }
  }
}
console.log(`feeds parity: ${ok} ok / ${bad} bad   (non-empty ${nonEmpty}, bare-attr ${bare}, files ${files.length})`);
for (const x of fails) console.log(x);
