//! Native tree-sitter substrate. Vendored grammars (compiled by build.rs) wrapped with the current
//! tree-sitter ABI. Parity with the web-tree-sitter grammars Seam bundles is proven (rust/README.md, Phase 0).

use tree_sitter::{Language, Node, Parser, TreeCursor};

mod grammar_c {
    extern "C" {
        pub fn tree_sitter_java() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_typescript() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_tsx() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_javascript() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_ruby() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_python() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_go() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_c_sharp() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_kotlin() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_c() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_cpp() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_html() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_rust() -> *const tree_sitter::ffi::TSLanguage;
        pub fn tree_sitter_vue() -> *const tree_sitter::ffi::TSLanguage;
    }
}

/// The native `Language` for a grammar name, or `None` if not vendored yet. Names are GRAMMAR names
/// (`java`, `typescript`, `tsx`, `javascript`), selected per file extension by `grammar_for` — a `.tsx`
/// file needs the tsx grammar, a `.js` file the javascript grammar (see `provider::grammar_for`).
pub fn language(name: &str) -> Option<Language> {
    match name {
        "java" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_java()) }),
        "typescript" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_typescript()) }),
        "tsx" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_tsx()) }),
        "javascript" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_javascript()) }),
        "ruby" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_ruby()) }),
        "python" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_python()) }),
        "go" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_go()) }),
        // the npm package is `tree-sitter-c-sharp`, so the symbol is `tree_sitter_c_sharp`; the GRAMMAR name
        // this engine uses is `csharp` (see GRAMMAR_BY_EXT), and the two must not be conflated
        "csharp" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_c_sharp()) }),
        "kotlin" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_kotlin()) }),
        "c" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_c()) }),
        "cpp" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_cpp()) }),
        // TEMPLATE grammar — not a source language. The learned `attr` matcher reads it (an AngularJS `ng-*` /
        // Vue `@click` attribute is how a front-end CONSUMES a binding), so without it every .html complement
        // is invisible while the rest of the coupling still resolves.
        "html" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_html()) }),
        "rust" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_rust()) }),
        "vue" => Some(unsafe { Language::from_raw(grammar_c::tree_sitter_vue()) }),
        _ => None,
    }
}

/// The grammars actually LINKED into this addon — the honest capability list.
///
/// This exists because a missing grammar degrades SILENTLY: `Ctx::parse` returns `None`, every AST scan yields
/// nothing, and the grow returns a well-formed graph that is simply missing the consumers it could not parse
/// (measured: a two-file Ruby repo where the TS engine reaches both files and this one reaches the anchor
/// alone). A caller cannot tell that apart from a genuine "nothing found", so the capability has to be
/// ASKABLE — the router uses it to keep a language this engine cannot read on the TS path.
pub fn vendored_grammars() -> &'static [&'static str] {
    // Derived from `language()` — the ONE place a grammar is linked. Keeping a hand-written list next to it is
    // how the capability drifts from the truth, and a capability that overstates is worse than none: the router
    // would send a language here that parses to nothing and the answer would look complete.
    &["java", "typescript", "tsx", "javascript", "ruby", "python", "go", "csharp", "kotlin", "c", "cpp", "html", "rust", "vue"]
}

/// A parsed file — an immutable AST + its source, with the small read-only query surface the AST scans use
/// (port of the TS `Ctx`). Owns the tree; nodes borrow from it, so a `Ctx` is self-contained.
pub struct Ctx {
    source: String,
    tree: tree_sitter::Tree,
}

impl Ctx {
    /// Parse `source` with `lang`'s grammar. `None` if the grammar isn't vendored or parsing fails.
    pub fn parse(source: &str, lang: &str) -> Option<Ctx> {
        let language = language(lang)?;
        let mut parser = Parser::new();
        parser.set_language(&language).ok()?;
        let tree = parser.parse(source, None)?;
        Some(Ctx { source: source.to_string(), tree })
    }

    pub fn root(&self) -> Node<'_> {
        self.tree.root_node()
    }

    /// The node's source text.
    pub fn text<'a>(&'a self, n: Node) -> &'a str {
        &self.source[n.start_byte()..n.end_byte()]
    }

    /// ALL children (named and anonymous), in order — matches TS `Ctx.children`.
    pub fn children<'a>(&self, n: Node<'a>) -> Vec<Node<'a>> {
        (0..n.child_count()).filter_map(|i| n.child(i)).collect()
    }

    /// Descendants of `root` whose kind satisfies `pred`, in TS `collect` order (a pre-order DFS visiting
    /// children last-to-first — the LIFO-stack order the extractors are byte-identical to). Recurses THROUGH
    /// matched nodes, so nested matches are found.
    pub fn collect<'a>(&self, root: Node<'a>, pred: impl Fn(&str) -> bool) -> Vec<Node<'a>> {
        let mut out = Vec::new();
        let mut st = vec![root];
        while let Some(x) = st.pop() {
            if pred(x.kind()) {
                out.push(x);
            }
            for i in 0..x.child_count() {
                if let Some(c) = x.child(i) {
                    st.push(c);
                }
            }
        }
        out
    }

    /// 0-based line of a byte offset (count of `\n` before it) — TS `Ctx.ln`.
    pub fn line_of(&self, byte_off: usize) -> usize {
        self.source.as_bytes()[..byte_off].iter().filter(|&&b| b == b'\n').count()
    }

    /// The 0-based COLUMN of a byte offset, counted in UTF-16 code units from the line start — the unit the
    /// TS side counts in (`Ctx.col`) and the unit an LSP position is expressed in. Counting bytes instead
    /// would drift by one per non-ASCII character earlier on the line, which is how a verification candidate
    /// lands on the wrong token in a file with an accented identifier or an emoji in a string.
    pub fn col(&self, byte_off: usize) -> usize {
        let head = &self.source[..byte_off.min(self.source.len())];
        let line_start = head.rfind('\n').map(|i| i + 1).unwrap_or(0);
        self.source[line_start..byte_off.min(self.source.len())].encode_utf16().count()
    }

    /// [start line, end line] of a node — TS `Ctx.span`.
    pub fn span(&self, n: Node) -> (usize, usize) {
        (self.line_of(n.start_byte()), self.line_of(n.end_byte()))
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
