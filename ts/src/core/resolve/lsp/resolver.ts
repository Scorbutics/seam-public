// Headless LSP resolver — STUB. The real DaemonResolver (vscode-jsonrpc + spawned language servers,
// warm daemon, deterministic fallback) is ported in the LSP phase (see ts/PORT-STATUS.md). Until
// then, --resolver lsp|auto errors clearly and the deterministic floor (--resolver det) is the path.
import type { Resolver } from "../consumers.js";

export class DaemonResolver implements Resolver {
  constructor(_fallback: boolean) {
    throw new Error("headless LSP resolver not yet ported — use --resolver det");
  }
  resolve_module(): string | null { return null; }
}
