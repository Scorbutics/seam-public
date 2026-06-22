// Build the engine into a CommonJS bundle at dist/seam.cjs (+ a grammar pack at dist/wasm/) — the
// artifact the MCP server prefers over re-transpiling the source CLI per call.
//
// NOT `bun build --compile`: that single-binary path DROPS web-tree-sitter's core tree-sitter.wasm
// (web-tree-sitter loads it relative to its package dir, which a compiled binary doesn't carry), so the
// binary ABORTS on the first parse. We use the SAME proven mechanism as vscode-extension/build.mjs:
// esbuild → CJS, keep web-tree-sitter EXTERNAL (it resolves from node_modules and finds its own wasm),
// and copy the grammar pack so the runner can point SEAM_WASM_DIR at it. Run with: bun build.mjs
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "dist");
const WASM_SRC = join(HERE, "node_modules", "tree-sitter-wasms", "out");

// esbuild is a repo-level devDependency (vscode-extension/); resolve it there when it isn't hoisted
// into ts/node_modules, so the build works from a plain checkout without a separate install.
async function loadEsbuild() {
  for (const p of ["esbuild", resolve(HERE, "..", "vscode-extension", "node_modules", "esbuild", "lib", "main.js")]) {
    try { return await import(p); } catch { /* try next */ }
  }
  throw new Error("esbuild not found (expected in vscode-extension/node_modules) — run its install first");
}
const { build } = await loadEsbuild();

// The source uses TS's `.js`-extension import style ("./facts.js" → facts.ts); map those to the .ts
// sibling (bun does this transparently; esbuild needs the nudge). Mirrors the extension's build.
const tsImports = {
  name: "ts-import-extensions",
  setup(b) {
    b.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const tsPath = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      return existsSync(tsPath) ? { path: tsPath } : undefined;
    });
  },
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [join(HERE, "src", "cli", "decompose.ts")],
  outfile: join(OUT, "seam.cjs"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  // web-tree-sitter loads its own core wasm relative to its package — keep it on disk, unbundled.
  // @xenova/transformers (opt-in embedding recall) stays external so the bundle doesn't carry ~23 MB.
  external: ["web-tree-sitter", "@xenova/transformers"],
  plugins: [tsImports],
  logLevel: "info",
  legalComments: "none",
});

// Grammar pack for codebase mode — the runner points SEAM_WASM_DIR here.
mkdirSync(join(OUT, "wasm"), { recursive: true });
cpSync(WASM_SRC, join(OUT, "wasm"), { recursive: true });

console.log(`\nEngine bundled → ${OUT}/seam.cjs  (+ wasm/ grammar pack)`);
