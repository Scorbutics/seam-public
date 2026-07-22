// napi-build wires up the platform link args so the cdylib loads as a Node/bun addon.
// We also compile the VENDORED tree-sitter-java grammar (parser.c, ABI 14) against this crate's single
// tree-sitter 0.25 runtime — the Phase 1 pattern for pinning a grammar to the wasm's source version.
fn main() {
    napi_build::setup();
    cc::Build::new()
        .include("vendor/java")
        .file("vendor/java/parser.c")
        .warnings(false)
        .compile("tree_sitter_java_grammar");
    println!("cargo:rerun-if-changed=vendor/java/parser.c");
}
