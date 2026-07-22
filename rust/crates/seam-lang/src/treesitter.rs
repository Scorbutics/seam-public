//! Native tree-sitter substrate. Vendored grammars (compiled by build.rs) wrapped with the current
//! tree-sitter ABI. Parity with the web-tree-sitter grammars Seam bundles is proven (rust/README.md, Phase 0).

use tree_sitter::{Language, Node, Parser, TreeCursor};

mod grammar_c {
    extern "C" {
        pub fn tree_sitter_java() -> *const tree_sitter::ffi::TSLanguage;
    }
}

/// The native `Language` for a grammar name, or `None` if not vendored yet.
pub fn language(name: &str) -> Option<Language> {
    match name {
        "java" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_java()) }),
        _ => None,
    }
}

/// Parity/debug helper: parse `source` with `lang`'s grammar → `depth|field|kind|start-end` per node
/// (pre-order DFS). Drives rust/parity/parity.ts.
pub fn parse_kinds(source: &str, lang: &str) -> Result<Vec<String>, String> {
    let language = language(lang).ok_or_else(|| format!("no native grammar for {lang}"))?;
    let mut parser = Parser::new();
    parser.set_language(&language).map_err(|e| e.to_string())?;
    let tree = parser.parse(source, None).ok_or("parse returned None")?;
    let mut out = Vec::new();
    walk(&mut tree.walk(), 0, &mut out);
    Ok(out)
}

fn walk(cursor: &mut TreeCursor, depth: usize, out: &mut Vec<String>) {
    let node: Node = cursor.node();
    let field = cursor.field_name().unwrap_or("");
    out.push(format!("{depth}|{field}|{}|{}-{}", node.kind(), node.start_byte(), node.end_byte()));
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
