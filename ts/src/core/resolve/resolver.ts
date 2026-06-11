// Port of src/core/resolve/resolver.py — the resolver strategy. 'det' = the offline floor (no
// server, instant). 'lsp'/'auto' = a real language server (headless, via the LSP stack), lazily
// loaded so the toolchain is only touched when asked.
import { floor_resolve } from "./languages/index.js";
import { normpath } from "./walk.js";
import type { Resolver } from "./consumers.js";

export class DeterministicResolver implements Resolver {
  resolve_module(repo: string, importingFile: string, source: string): string | null {
    return floor_resolve(normpath(repo).replace(/^~/, process.env.HOME ?? "~"), importingFile, source);
  }
}

// 'det' → null (the deterministic floor). 'lsp'/'auto' → the headless language server.
//
// NOTE: the headless LSP resolver is deliberately deferred to land WITH codebase mode. Diff-mode
// blast-radius is well served by the floor (relative + package.json + tsconfig `paths`; node_modules
// and external are correctly excluded anyway), and an interactive LSP client is async while `_resolve`
// is called synchronously deep in the pipeline — bridging that (a worker+Atomics sync shim, or an
// async refactor of the emit path) is best done once, with codebase mode, where the LSP's precision
// actually pays off. Until then, lsp/auto degrade to the floor so the CLI/extension never error.
export async function make_resolver(kind: string): Promise<Resolver | null> {
  if (kind !== "det") {
    process.stderr.write(`note: --resolver ${kind} (headless LSP) not yet ported in the TS engine; `
      + `using the deterministic floor (lands with codebase mode).\n`);
  }
  return null;
}
