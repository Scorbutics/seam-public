//! Seam Rust core — PHASE 0 de-risk spike.
//!
//! Two exports, one per load-bearing assumption of the whole migration:
//!   * `hello` / `add`  — proves bun can call an in-process Rust napi addon at all.
//!   * `parse_kinds`    — proves native tree-sitter parity: dumps every AST node as
//!                        `kind` (+ tree-sitter field, + byte span) in a stable pre-order,
//!                        so a TS dump from web-tree-sitter can be diffed against it byte-for-byte.
//!
//! The dump format is deliberately identical to what the TS side emits (see ts/parity_dump.ts):
//!   one line per named+anonymous node — `depth|field|kind|start-end` — pre-order DFS.

use napi_derive::napi;
use tree_sitter::{Node, Parser, TreeCursor};

// The pinned grammar's raw C entry point. tree-sitter-java 0.20.2's build compiles parser.c which exports
// `tree_sitter_java`; we bind it directly (bypassing the crate's own tree-sitter 0.20 Rust wrapper) and
// re-wrap with the current tree-sitter ABI in `parse_kinds`.
mod java_raw {
    extern "C" {
        pub fn tree_sitter_java() -> *const tree_sitter::ffi::TSLanguage;
    }
}

#[napi]
pub fn hello(name: String) -> String {
    format!("hello {name} — from rust {}", env!("CARGO_PKG_VERSION"))
}

#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

/// Parse `source` with the native grammar for `lang` and return one line per AST node:
/// `depth|field|kind|start-end`. Returns an `Err` string if the language is unknown or parsing fails.
#[napi]
pub fn parse_kinds(source: String, lang: String) -> napi::Result<Vec<String>> {
    let language = match lang.as_str() {
        // Wrap the pinned-0.20.2 grammar's raw C constructor with the CURRENT tree-sitter ABI, so the
        // node-kinds match the bundled wasm rather than a newer crate. (from_raw is safe here: the symbol
        // comes from a real generated grammar and tree-sitter 0.25 loads its ABI-13 tables.)
        "java" => unsafe { tree_sitter::Language::from_raw(java_raw::tree_sitter_java()) },
        other => {
            return Err(napi::Error::from_reason(format!(
                "phase0: no native grammar wired for {other} yet"
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

/// Pre-order DFS emitting one line per node. Mirrors a `walk` over web-tree-sitter's TreeCursor:
/// includes anonymous nodes (so token-level structure is compared too) and the field name the node
/// occupies in its parent (the thing `childForFieldName` reads — critical for parity).
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
