// Port of src/core/resolve/resolver.py — the resolver strategy. 'det' = the offline floor (no
// server, instant). 'lsp'/'auto' = a real language server (headless, via the LSP stack), lazily
// loaded so the toolchain is only touched when asked. The Resolver interface is ASYNC (the LSP path
// is async I/O); the deterministic floor awaits trivially.
import { floor_resolve } from "./languages/index.js";
import type { Resolver } from "./consumers.js";

const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "~") + p.slice(1) : p);

// The deterministic FLOOR — per-language offline resolution (relative / package / tsconfig alias),
// dispatched to the importing file's language provider. TS is implemented; a language with no floor
// resolves to null (resolution then relies on the LSP).
export class DeterministicResolver implements Resolver {
  async resolve_module(repo: string, importingFile: string, source: string): Promise<string | null> {
    return floor_resolve(expanduser(repo), importingFile, source);
  }
}

// 'det' → null (keep the scan's built-in deterministic path). 'lsp' → LSP only; 'auto' → LSP with
// deterministic fallback. 'lsp'/'auto' route through the persistent daemon (P4: warm servers reused
// across invocations; degrades to in-process LSP then the floor).
export async function make_resolver(kind: string): Promise<Resolver | null> {
  if (kind === "det") return null;                   // the scan's built-in deterministic path
  const { DaemonResolver } = await import("./lsp/resolver.js");  // lazy: load the LSP stack only when asked
  return new DaemonResolver(kind === "auto");
}
