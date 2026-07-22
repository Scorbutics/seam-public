// Compile the VENDORED tree-sitter grammars (parser.c) against this crate's single tree-sitter runtime — the
// pattern for pinning a grammar to the exact source version tree-sitter-wasms bundles (see rust/README.md).
fn main() {
    cc::Build::new()
        .include("vendor/java")
        .file("vendor/java/parser.c")
        .warnings(false)
        .compile("tree_sitter_java_grammar");
    println!("cargo:rerun-if-changed=vendor/java/parser.c");

    // TypeScript: a generated parser.c + a small external scanner (scanner.c → common/scanner.h). The
    // `src` include resolves the grammar's vendored `tree_sitter/parser.h` (ABI 14); scanner symbols are
    // grammar-prefixed so typescript/tsx don't collide.
    cc::Build::new()
        .include("vendor/typescript/src")
        .file("vendor/typescript/src/parser.c")
        .file("vendor/typescript/src/scanner.c")
        .warnings(false)
        .compile("tree_sitter_typescript_grammar");
    println!("cargo:rerun-if-changed=vendor/typescript/src/parser.c");
    println!("cargo:rerun-if-changed=vendor/typescript/src/scanner.c");
    println!("cargo:rerun-if-changed=vendor/common/scanner.h");

    // TSX — the sibling grammar in tree-sitter-typescript (its own parser + scanner, sharing common/scanner.h).
    cc::Build::new()
        .include("vendor/tsx/src")
        .file("vendor/tsx/src/parser.c")
        .file("vendor/tsx/src/scanner.c")
        .warnings(false)
        .compile("tree_sitter_tsx_grammar");
    println!("cargo:rerun-if-changed=vendor/tsx/src/parser.c");
    println!("cargo:rerun-if-changed=vendor/tsx/src/scanner.c");

    // JavaScript — a self-contained grammar (its own parser + external scanner, no shared common header).
    cc::Build::new()
        .include("vendor/javascript/src")
        .file("vendor/javascript/src/parser.c")
        .file("vendor/javascript/src/scanner.c")
        .warnings(false)
        .compile("tree_sitter_javascript_grammar");
    println!("cargo:rerun-if-changed=vendor/javascript/src/parser.c");
    println!("cargo:rerun-if-changed=vendor/javascript/src/scanner.c");
}
