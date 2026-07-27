// GRAMMAR PARITY — the newly vendored native grammars vs the wasm ones the TS engine loads.
//
// Vendoring a grammar is only safe if the NATIVE parser and the WASM parser agree about the tree. They are
// separate builds of the same grammar, pinned to the same version (tree-sitter-wasms@0.1.13), and if they ever
// drift the failure is silent and total: every AST scan reads a different shape, so the two engines answer
// differently while both look healthy. That is exactly the failure the router's `canParse` gate was protecting
// against — so before a grammar is declared vendored, its trees have to match here.
//
// Compares the NODE-KIND SEQUENCE of a pre-order walk (kind + child count), which is the structure every scan
// in this engine is built on. Byte offsets are deliberately NOT compared: the harness passes a JS string across
// napi, which re-encodes it, so offsets inflate on non-UTF-8-clean input (a known artifact documented in
// rust/README.md — the real core reads raw bytes and sidesteps it).
//
//   bun rust/parity/grammars.ts
import { createRequire } from "node:module";
import { makeCtx, available } from "../../ts/src/codebase/atoms.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

// One SMALL but structurally varied sample per language: declarations, a call, a string, a comment, and the
// construct the coupling floor keys off (a route/table/require), so a drift in the parts this engine actually
// reads shows up rather than a toy `a = 1`.
const SAMPLES: { lang: string; file: string; src: string }[] = [
  { lang: "ruby", file: "a.rb", src: `require 'json'\n# c\nclass Repo\n  def save(id)\n    DB[:widgets].insert(id: id)\n  end\nend\n` },
  { lang: "python", file: "a.py", src: `import os\n# c\nclass Repo:\n    def save(self, id):\n        return db.execute("INSERT INTO widgets VALUES (?)", id)\n` },
  { lang: "go", file: "a.go", src: `package main\n\nimport "net/http"\n\n// c\nfunc Save(id string) error {\n\treturn http.Post("/api/widgets", "application/json", nil)\n}\n` },
  { lang: "csharp", file: "a.cs", src: `using System;\n\n// c\nnamespace App {\n  public class Repo {\n    public void Save(string id) { Db.Insert("widgets", id); }\n  }\n}\n` },
  { lang: "kotlin", file: "a.kt", src: `package app\n\nimport java.util.List\n\n// c\nclass Repo {\n  fun save(id: String) { db.insert("widgets", id) }\n}\n` },
  { lang: "c", file: "a.c", src: `#include <stdio.h>\n/* c */\nint save(const char *id) {\n  return db_insert("widgets", id);\n}\n` },
  // TEMPLATE grammar, not a source language — the learned `attr` matcher's input. The sample carries an
  // AngularJS `ng-*` and a Vue-style `@click`, which is the construct the coupling floor keys off here.
  { lang: "html", file: "a.html", src: `<!-- c -->\n<div class="row">\n  <button ng-click="refreshSection()">Refresh</button>\n  <a @click="save(id)">Save</a>\n</div>\n` },
  { lang: "cpp", file: "a.cpp", src: `#include <string>\n// c\nclass Repo {\npublic:\n  int save(const std::string &id) { return db_insert("widgets", id); }\n};\n` },
];

// Pre-order KIND walk — the structure every scan in this engine reads. Child counts are left out: the addon's
// `parseKinds` reports `index|field|kind|start-end` rows, and the kind SEQUENCE of a pre-order walk already
// pins the tree shape (a differing shape reorders or resizes it).
const walkTs = (ctx: any): string[] => {
  const out: string[] = [];
  const visit = (n: any) => { out.push(n.type); for (const c of ctx.children(n)) visit(c); };
  visit(ctx.root);
  return out;
};
// `index|field|kind|start-end` → the kind column.
const kindsOfRust = (rows: string[]): string[] => rows.map((r) => r.split("|")[2] ?? r);

let ok = 0, bad = 0;
const fails: string[] = [];
if (!available()) { console.log("grammar parity: SKIPPED — tree-sitter unavailable"); process.exit(0); }

for (const s of SAMPLES) {
  const ctx = await makeCtx(s.src, s.lang);
  if (!ctx) { bad++; fails.push(`✗ ${s.lang}: the TS engine could not parse the sample (no wasm?)`); continue; }
  const ts = walkTs(ctx);
  let rust: string[];
  try { rust = kindsOfRust(addon.parseKinds(s.src, s.lang)); } catch (e) { bad++; fails.push(`✗ ${s.lang}: the addon threw — ${String(e).slice(0, 90)}`); continue; }
  if (ts.join("\n") === rust.join("\n")) { ok++; continue; }
  bad++;
  const k = ts.findIndex((l, i) => l !== rust[i]);
  fails.push(`✗ ${s.lang}  nodes ts=${ts.length} rust=${rust.length}, first diff @${k}\n  ts:   ${ts.slice(Math.max(0, k - 2), k + 3).join(" ")}\n  rust: ${rust.slice(Math.max(0, k - 2), k + 3).join(" ")}`);
}

console.log(`\ngrammar parity (native vendored vs wasm): ${ok} ok / ${bad} bad  over ${SAMPLES.length} language(s)`);
for (const f of fails) console.log(f);
process.exit(bad ? 1 : 0);
