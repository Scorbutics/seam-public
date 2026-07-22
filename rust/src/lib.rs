//! Seam Rust core — napi bindings.
//!
//! Phase 1: the foundation for the first vertical slice (`--query consumers`), ported byte-identical
//! against the TS engine. STRUCTURE lives here (parse / resolve / …); the TS shell keeps semantics + I/O
//! + render. This file is only the napi surface — the logic lives in the modules.

use napi_derive::napi;
use tree_sitter::{Node, Parser, TreeCursor};

pub mod lang;
pub mod walk;
pub use lang::ImportRef;

// The pinned Java grammar's raw C entry point (vendor/java/parser.c). Bound directly and re-wrapped with the
// current tree-sitter ABI so node-kinds match the bundled wasm. See rust/README.md (Phase 0).
mod java_raw {
    extern "C" {
        pub fn tree_sitter_java() -> *const tree_sitter::ffi::TSLanguage;
    }
}

// ── Language: imports ────────────────────────────────────────────────────────────────────────────────────────

/// Port of the Java provider's `imports(text)` (languages/java/resolve.ts): the file's `import a.b.C;` /
/// `import static …` refs (wildcards skipped). Regex-based, no tree-sitter — the reverse-import index is built
/// from this. Byte-identical to TS `parse_imports` for a `.java` file (see rust/parity/imports.ts).
#[napi]
pub fn java_imports(text: String) -> Vec<ImportRef> {
    lang::java::imports(&text)
}

/// Port of the TS/JS provider's `imports(text)` — named `{…}` imports, barrel re-exports, and dynamic
/// `import("…")`. Byte-identical to TS `parse_imports` for a `.ts/.js/.tsx/…` file (see rust/parity/imports_ts.ts).
#[napi]
pub fn ts_imports(text: String) -> Vec<ImportRef> {
    lang::typescript::imports(&text)
}

/// Port of the Ruby provider's `imports(text)` — `require` / `require_relative` / `autoload`. Byte-identical
/// to TS `parse_imports` for a `.rb`/`.rake` file.
#[napi]
pub fn ruby_imports(text: String) -> Vec<ImportRef> {
    lang::ruby::imports(&text)
}

/// Port of the Java provider's `floor_resolve` over a batch of `[importing_file, source]` pairs (each
/// resolved to a repo-relative file, or null). Builds the FQN index once. Byte-identical to TS `floor_resolve`
/// (see rust/parity/resolve.ts).
#[napi]
pub fn java_resolve_batch(repo: String, queries: Vec<Vec<String>>) -> Vec<Option<String>> {
    let pairs: Vec<(String, String)> = queries
        .into_iter()
        .map(|q| (q.first().cloned().unwrap_or_default(), q.get(1).cloned().unwrap_or_default()))
        .collect();
    lang::java::resolve_batch(&repo, &pairs)
}

// ── Phase 0 spike exports (kept: the napi round-trip proof + the tree-sitter parity harness) ──────────────────

#[napi]
pub fn hello(name: String) -> String {
    format!("hello {name} — from rust {}", env!("CARGO_PKG_VERSION"))
}

/// Parse `source` with the native pinned grammar for `lang` → `depth|field|kind|start-end` per node
/// (pre-order DFS). Drives the AST-parity harness (rust/parity/parity.ts).
#[napi]
pub fn parse_kinds(source: String, lang: String) -> napi::Result<Vec<String>> {
    let language = match lang.as_str() {
        "java" => unsafe { tree_sitter::Language::from_raw(java_raw::tree_sitter_java()) },
        other => {
            return Err(napi::Error::from_reason(format!(
                "no native grammar wired for {other} yet"
            )))
        }
    };
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|e| napi::Error::from_reason(format!("set_language: {e}")))?;
    let tree = parser
        .parse(&source, None)
        .ok_or_else(|| napi::Error::from_reason("parse returned None"))?;
    let mut out = Vec::new();
    let mut cursor = tree.walk();
    walk(&mut cursor, 0, &mut out);
    Ok(out)
}

fn walk(cursor: &mut TreeCursor, depth: usize, out: &mut Vec<String>) {
    let node: Node = cursor.node();
    let field = cursor.field_name().unwrap_or("");
    out.push(format!(
        "{depth}|{field}|{}|{}-{}",
        node.kind(),
        node.start_byte(),
        node.end_byte()
    ));
    if cursor.goto_first_child() {
        loop {
            walk(cursor, depth + 1, out);
            if !cursor.goto_next_sibling() {
                break;
            }
        }
        cursor.goto_parent();
    }
}
