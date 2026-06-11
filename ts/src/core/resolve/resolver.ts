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

// 'det' → null (the scan's built-in deterministic floor); 'lsp'/'auto' → the LSP DaemonResolver
// (headless language server — ported in the LSP phase; see ts/PORT-STATUS.md).
export async function make_resolver(kind: string): Promise<Resolver | null> {
  if (kind === "det") return null;
  const lsp = await import("./lsp/resolver.js").catch(() => null);
  if (!lsp) throw new Error(`--resolver ${kind} (headless LSP) is not yet ported; use --resolver det.`);
  return new lsp.DaemonResolver(kind === "auto");
}
