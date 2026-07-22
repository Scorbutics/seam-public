// Compile the VENDORED tree-sitter grammars (parser.c) against this crate's single tree-sitter runtime — the
// pattern for pinning a grammar to the exact source version tree-sitter-wasms bundles (see rust/README.md).
fn main() {
    cc::Build::new()
        .include("vendor/java")
        .file("vendor/java/parser.c")
        .warnings(false)
        .compile("tree_sitter_java_grammar");
    println!("cargo:rerun-if-changed=vendor/java/parser.c");
}
