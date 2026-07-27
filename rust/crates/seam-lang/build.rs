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

    // ruby — vendored at the tree-sitter-wasms@0.1.13 pin (see rust/README.md): the wasm the TS engine loads
    // and this native parser MUST be the same grammar version, or the two engines disagree about the AST.
    cc::Build::new()
        .include("vendor/ruby/src")
        .file("vendor/ruby/src/parser.c")
        .file("vendor/ruby/src/scanner.c")
        .warnings(false)
        .compile("tree_sitter_ruby_grammar");
    println!("cargo:rerun-if-changed=vendor/ruby/src/parser.c");
    println!("cargo:rerun-if-changed=vendor/ruby/src/scanner.c");

    // python — vendored at the tree-sitter-wasms@0.1.13 pin (see rust/README.md): the wasm the TS engine loads
    // and this native parser MUST be the same grammar version, or the two engines disagree about the AST.
    cc::Build::new()
        .include("vendor/python/src")
        .file("vendor/python/src/parser.c")
        .file("vendor/python/src/scanner.c")
        .warnings(false)
        .compile("tree_sitter_python_grammar");
    println!("cargo:rerun-if-changed=vendor/python/src/parser.c");
    println!("cargo:rerun-if-changed=vendor/python/src/scanner.c");

    // go — vendored at the tree-sitter-wasms@0.1.13 pin (see rust/README.md): the wasm the TS engine loads
    // and this native parser MUST be the same grammar version, or the two engines disagree about the AST.
    cc::Build::new()
        .include("vendor/go/src")
        .file("vendor/go/src/parser.c")
        .warnings(false)
        .compile("tree_sitter_go_grammar");
    println!("cargo:rerun-if-changed=vendor/go/src/parser.c");

    // csharp — vendored at the tree-sitter-wasms@0.1.13 pin (see rust/README.md): the wasm the TS engine loads
    // and this native parser MUST be the same grammar version, or the two engines disagree about the AST.
    cc::Build::new()
        .include("vendor/csharp/src")
        .file("vendor/csharp/src/parser.c")
        .file("vendor/csharp/src/scanner.c")
        .warnings(false)
        .compile("tree_sitter_csharp_grammar");
    println!("cargo:rerun-if-changed=vendor/csharp/src/parser.c");
    println!("cargo:rerun-if-changed=vendor/csharp/src/scanner.c");

    // kotlin — vendored at the tree-sitter-wasms@0.1.13 pin (see rust/README.md): the wasm the TS engine loads
    // and this native parser MUST be the same grammar version, or the two engines disagree about the AST.
    cc::Build::new()
        .include("vendor/kotlin/src")
        .file("vendor/kotlin/src/parser.c")
        .file("vendor/kotlin/src/scanner.c")
        .warnings(false)
        .compile("tree_sitter_kotlin_grammar");
    println!("cargo:rerun-if-changed=vendor/kotlin/src/parser.c");
    println!("cargo:rerun-if-changed=vendor/kotlin/src/scanner.c");

    // c — vendored at the tree-sitter-wasms@0.1.13 pin (see rust/README.md): the wasm the TS engine loads
    // and this native parser MUST be the same grammar version, or the two engines disagree about the AST.
    cc::Build::new()
        .include("vendor/c/src")
        .file("vendor/c/src/parser.c")
        .warnings(false)
        .compile("tree_sitter_c_grammar");
    println!("cargo:rerun-if-changed=vendor/c/src/parser.c");

    // cpp — vendored at the tree-sitter-wasms@0.1.13 pin (see rust/README.md): the wasm the TS engine loads
    // and this native parser MUST be the same grammar version, or the two engines disagree about the AST.
    cc::Build::new()
        .include("vendor/cpp/src")
        .file("vendor/cpp/src/parser.c")
        .file("vendor/cpp/src/scanner.c")
        .warnings(false)
        .compile("tree_sitter_cpp_grammar");
    println!("cargo:rerun-if-changed=vendor/cpp/src/parser.c");
    println!("cargo:rerun-if-changed=vendor/cpp/src/scanner.c");
}
