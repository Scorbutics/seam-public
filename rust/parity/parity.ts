// PHASE 0 diff harness — AST parity between the native Rust grammar and the web-tree-sitter grammar
// Seam bundles. Parses the same file both ways, dumps every node as `depth|field|kind|start-end` in
// pre-order DFS, and reports the first divergences. If these match, byte-identical is FEASIBLE; if the
// node-kinds/fields differ, the plan needs grammar-version pinning before Phase 1.
//
//   bun rust/parity/parity.ts <file.java>   (defaults to the K7 anchor)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { getParser } from "../../ts/src/core/treesitter.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_phase0.node");

// Recursive pre-order walk over a web-tree-sitter node, matching the Rust TreeCursor walk exactly:
// every child (named AND anonymous), the field it occupies in its parent, and its byte span.
function tsDump(node: any, depth: number, field: string, out: string[]): void {
  out.push(`${depth}|${field}|${node.type}|${node.startIndex}-${node.endIndex}`);
  const n = node.childCount;
  for (let i = 0; i < n; i++) {
    tsDump(node.child(i), depth + 1, node.fieldNameForChild(i) ?? "", out);
  }
}

async function main() {
  const file =
    process.argv[2] ??
    "/home/scorbutics/dev/keycloak/services/src/main/java/org/keycloak/protocol/oidc/grants/RefreshTokenGrantType.java";
  const src = readFileSync(file, "utf-8");
  const ascii = /^[\x00-\x7F]*$/.test(src);

  // native Rust
  const rust: string[] = addon.parseKinds(src, "java");

  // web-tree-sitter (what Seam runs today)
  const parser = await getParser("java");
  if (!parser) throw new Error("no web-tree-sitter java grammar (node_modules/tree-sitter-wasms)");
  const tree = parser.parse(src);
  const ts: string[] = [];
  tsDump(tree.rootNode, 0, "", ts);

  // Compare on two levels: FULL (kind+field+span) and STRUCTURE-only (kind+field, span dropped). Structure is
  // the grammar-parity question that matters; span mismatches on non-ASCII files are a harness artifact — the
  // string is re-encoded crossing napi, whereas the real core reads raw file bytes (true byte offsets = the unit
  // web-tree-sitter already reports). So structure divergence = a real grammar-version problem; span-only
  // divergence on a non-ASCII file = the known offset detail, not a blocker.
  const stripSpan = (s: string) => s.slice(0, s.lastIndexOf("|"));
  const n = Math.min(rust.length, ts.length);
  let firstFull = -1, firstStruct = -1;
  const diffs: string[] = [];
  for (let i = 0; i < n; i++) {
    if (rust[i] !== ts[i] && firstFull < 0) firstFull = i;
    if (stripSpan(rust[i]) !== stripSpan(ts[i])) {
      if (firstStruct < 0) firstStruct = i;
      if (diffs.length < 12) diffs.push(`  node ${i}:\n    rust: ${rust[i]}\n    ts:   ${ts[i]}`);
    }
  }
  const sameLen = rust.length === ts.length;
  const structOk = sameLen && firstStruct < 0;
  const fullOk = sameLen && firstFull < 0;

  console.log(`file:       ${file.split("/").pop()}  (${src.length} chars, ascii=${ascii})`);
  console.log(`nodes:      rust ${rust.length} · ts ${ts.length}`);
  if (fullOk) console.log("\n✅ IDENTICAL — every node kind, field, and byte span matches.");
  else if (structOk) console.log(`\n🟡 STRUCTURE IDENTICAL (kinds + fields) — spans differ only (${ascii ? "unexpected on ASCII!" : "non-ASCII: napi re-encode artifact, not a grammar issue"}).`);
  else {
    console.log("\n❌ GRAMMAR DIVERGENCE — node kinds/fields differ (a real parity problem):");
    if (!sameLen) console.log(`  node counts differ: rust ${rust.length} vs ts ${ts.length}`);
    console.log(diffs.join("\n"));
  }
  // exit: 0 = full identical, 1 = structure-only (spans differ), 2 = grammar divergence
  process.exit(fullOk ? 0 : structOk ? 1 : 2);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(2);
});
