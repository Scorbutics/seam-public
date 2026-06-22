// Bundles the TypeScript engine (ts/) into self-contained CommonJS files under out/engine/, so the
// published extension carries the engine and needs neither a `bun` runtime nor the source checkout.
// The extension spawns these with VS Code's own Node (process.execPath + ELECTRON_RUN_AS_NODE=1).
//
// web-tree-sitter is kept external (it loads its own core .wasm relative to its package dir) and the
// grammar pack is copied verbatim; both are shipped under out/engine/node_modules and pointed at via
// SEAM_WASM_DIR at spawn time. Diff review never touches them — only codebase mode does.
//
// Run with: bun build.mjs   (node/npm are absent in this environment — see CLAUDE.md / memory)
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const TS = join(REPO, "ts");
const OUT = join(HERE, "out", "engine");
const WASM_SRC = join(TS, "node_modules", "tree-sitter-wasms", "out");
const WTS_SRC = join(TS, "node_modules", "web-tree-sitter");

// The engine's source uses TypeScript's `.js`-extension import style ("./facts.js" → facts.ts).
// bun resolves these transparently; esbuild needs a nudge to map a relative `.js` import to its
// `.ts` sibling when one exists (and to leave genuine `.js` files alone).
const tsImports = {
  name: "ts-import-extensions",
  setup(b) {
    b.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const tsPath = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      return existsSync(tsPath) ? { path: tsPath } : undefined;
    });
  },
};

async function bundle(entry, outfile) {
  await build({
    entryPoints: [join(TS, "src", "cli", entry)],
    outfile: join(OUT, outfile),
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    // web-tree-sitter resolves its own core wasm relative to its package; keep it on disk, unbundled.
    // @xenova/transformers (embedding anchor recall, opt-in) is external so the default .vsix doesn't
    // carry its ~23 MB + model loader; when absent at runtime the engine's import throws and
    // embed_anchor_candidates catches it → falls back to the lexical floor (graceful, off by default).
    external: ["web-tree-sitter", "@xenova/transformers"],
    plugins: [tsImports],
    logLevel: "info",
    legalComments: "none",
  });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await bundle("decompose.ts", "decompose.cjs");
await bundle("anchor_rank.ts", "anchor_rank.cjs");
await bundle("adapters.ts", "adapters.cjs");   // the learned-adapter manager (list --json / promote)

// Codebase-mode assets (diff review does not need these). Copy the grammar pack and the
// web-tree-sitter package so the bundle's runtime `import("web-tree-sitter")` resolves on the user's
// machine. SEAM_WASM_DIR (set by the extension at spawn) points the engine at the copied grammars.
mkdirSync(join(OUT, "wasm"), { recursive: true });
cpSync(WASM_SRC, join(OUT, "wasm"), { recursive: true });
mkdirSync(join(OUT, "node_modules", "web-tree-sitter"), { recursive: true });
cpSync(WTS_SRC, join(OUT, "node_modules", "web-tree-sitter"), { recursive: true });

console.log(`\nEngine bundled → ${OUT}`);
console.log("  decompose.cjs, anchor_rank.cjs, adapters.cjs");
console.log("  wasm/ (tree-sitter grammars), node_modules/web-tree-sitter");
