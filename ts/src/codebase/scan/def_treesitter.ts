// TREE-SITTER DEF EXTRACTION — the language-agnostic counterpart to def_table's TS/JS-tuned regex.
// def_table.defs_in_file walks files in every registered language (the walker is registry-driven) but
// parses declarations with JS/JS-shaped regexes + C-style comment markers, so it degrades on Ruby
// (`def`, `#`, no braces), C/C++ (free functions), and partially Java. This producer parses the real
// AST via the shared `core/treesitter` substrate and reads declarations structurally, so signature +
// doc extraction works across the five required languages. Async (web-tree-sitter) and graceful: any
// missing grammar / parse failure returns null so the caller falls back to the regex floor.
import { getParser, langForExt } from "../../core/treesitter.js";
import { type Def, _body_window } from "./def_table.js";

// Tree-sitter node TYPES that declare a unit. These are grammar-specific structural constants (a closed
// set per grammar, not free text) — listed here as the cross-grammar UNION for the supported languages.
// Extend the sets when adding a grammar; never pattern-match identifier text. CONTAINER nodes also set
// the `enclosing` for the defs nested under them.
const CONTAINER = new Set([
  "class_declaration", "class_specifier", "class",        // ts/js/java · c++ · ruby
  "interface_declaration", "enum_declaration", "enum_specifier",
  "struct_specifier", "namespace_definition", "module",   // c/c++ · ruby
]);
const CALLABLE = new Set([
  "function_declaration", "function_definition",          // ts/js · c/c++
  "method_definition", "method_declaration", "method",    // ts/js · java · ruby
  "constructor_declaration",                              // java
]);
// const-arrow / function-expression assignment is JS/TS-only and has no dedicated declaration node —
// it hides under a variable binding — so it needs the special unwrap below (keeps parity with the regex
// floor, which matched `export const x = () => …`).
const _ARROW_HOLDERS = new Set(["lexical_declaration", "variable_declaration"]);
const _FN_VALUES = new Set(["arrow_function", "function", "function_expression"]);
// the identifier kinds a C/C++ function name resolves to once the declarator chain is unwrapped.
const _NAME_LEAVES = new Set(["identifier", "field_identifier", "qualified_identifier", "destructor_name", "operator_name", "type_identifier"]);

function _fieldName(n: any): string | null {
  const f = n.childForFieldName?.("name");
  return f ? f.text : null;
}

// C/C++ bury the function name inside the declarator (function_declarator, possibly wrapped in
// pointer_/reference_/parenthesized_declarator). Follow ONLY the `declarator` FIELD chain down to the
// identifier leaf — never descend into `parameters`, or a parameter name gets mistaken for the function
// name (`void on_log(LogListener* l)` → `on_log`, not `l`).
function _declaratorName(n: any): string | null {
  let x: any = n;
  for (let guard = 0; x && guard < 16; guard++) {
    if (_NAME_LEAVES.has(x.type)) return x.text;
    x = x.childForFieldName?.("declarator") ?? null;
  }
  return null;
}

const _stripComment = (t: string): string =>
  t.replace(/^\/\*+|\*+\/$/g, "").replace(/^[ \t]*[*#]\s?/gm, "").replace(/^\/\/\s?/gm, "")
    .replace(/^#\s?/, "").replace(/\s+/g, " ").trim();

// Comment nodes are tree-sitter EXTRAS — they float outside the named-sibling chain (a method's
// previousNamedSibling skips right past the `# doc` above it), and in many grammars aren't even a
// namedChild of the body. So index every comment by the row it ENDS on (one full traversal, using
// child() to catch extras), then attach by POSITION. Language-agnostic: a comment is whatever the
// grammar tagged `*comment*`.
function _collectComments(root: any): Map<number, { startRow: number; text: string }> {
  const byEndRow = new Map<number, { startRow: number; text: string }>();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type.includes("comment")) byEndRow.set(n.endPosition.row, { startRow: n.startPosition.row, text: n.text });
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i));
  }
  return byEndRow;
}

// The doc = the run of comment lines immediately above the declaration (no blank-line gap), walking
// upward through stacked single-line comments and multi-line blocks. Markers stripped, capped 200.
function _precedingDoc(startRow: number, comments: Map<number, { startRow: number; text: string }>): string {
  const parts: string[] = [];
  let row = startRow - 1;
  while (comments.has(row)) {
    const c = comments.get(row)!;
    parts.unshift(_stripComment(c.text));
    row = c.startRow - 1;
  }
  return parts.join(" ").slice(0, 200).trim();
}

// The signature = the SOURCE LINE the declaration starts on (trimmed, trailing `{` dropped) — same
// shape def_table emits, so embed/judge strings stay consistent across the two producers.
const _sigLine = (lines: string[], row: number): string =>
  (lines[row] ?? "").trim().replace(/[ \t]*\{[ \t]*$/, "");

// Parse `text` and return the declarations with name + signature line + enclosing container + doc.
// Returns null when tree-sitter can't handle the file (no grammar / parse fail) so the caller falls
// back to the regex floor — never throws.
export async function defs_in_file_treesitter(file: string, text: string): Promise<Def[] | null> {
  const dot = file.lastIndexOf(".");
  const grammar = langForExt(dot >= 0 ? file.slice(dot) : "");
  if (!grammar) return null;
  const parser = await getParser(grammar);
  if (!parser) return null;
  // KEEP the Tree (not just rootNode) so we can FREE its WASM memory below — this extractor runs once per
  // repo file (thousands on a big repo), and web-tree-sitter trees are NOT GC'd; leaking them exhausts the
  // WASM heap → an out-of-bounds crash mid-grow. The extracted Defs are plain objects (no node refs), so the
  // tree is safe to delete once extraction is done.
  let tree: any;
  try { tree = parser.parse(text); } catch { return null; }
  const root = tree.rootNode;

  const lines = text.split("\n");
  const comments = _collectComments(root);
  const out: Def[] = [];
  const mk = (name: string, kind: string, n: any, enclosing: string): Def =>
    ({ name, kind, file, signature: _sigLine(lines, n.startPosition.row), enclosing, doc: _precedingDoc(n.startPosition.row, comments) });
  const visit = (n: any, enclosing: string) => {
    let nextEnclosing = enclosing;
    if (CONTAINER.has(n.type)) {
      const name = _fieldName(n);
      if (name) { out.push(mk(name, n.type.includes("interface") ? "interface" : n.type.includes("enum") ? "enum" : "class", n, enclosing)); nextEnclosing = name; }
    } else if (CALLABLE.has(n.type)) {
      const name = _fieldName(n) ?? _declaratorName(n);
      // the BODY passage (calls/identifiers the signature+doc omit) — a forward line window from the
      // declaration row, shared with the regex extractor so both producers embed the same shape.
      if (name) out.push({ ...mk(name, enclosing ? "method" : "function", n, enclosing), body: _body_window(lines, n.startPosition.row) });
    } else if (_ARROW_HOLDERS.has(n.type)) {
      // const x = () => … : pull the declarator whose value is a function; name it like a function.
      for (let i = 0; i < n.namedChildCount; i++) {
        const d = n.namedChild(i);
        if (d.type !== "variable_declarator") continue;
        const v = d.childForFieldName?.("value");
        if (v && _FN_VALUES.has(v.type)) {
          const name = _fieldName(d);
          if (name) out.push(mk(name, enclosing ? "method" : "function", n, enclosing));
        }
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i), nextEnclosing);
  };
  visit(root, "");
  tree.delete?.();   // free the WASM tree (Defs are plain objects — no live node refs)
  return out;
}
