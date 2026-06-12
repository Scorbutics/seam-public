// Port of src/core/resolve/lsp/resolver.py — resolve an import through a real language server
// (go-to-definition on the module string), so @/ aliases / node_modules / sys.path / #include are the
// SERVER's job, not ours. `fallback=true` (the `auto` mode) drops to the deterministic floor when the
// LSP can't answer — a strict precision upgrade, never a regression. RESOLVE/down only.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve as pathResolve, sep } from "node:path";
import { LspPool } from "./pool.js";
import type { Resolver } from "../consumers.js";

const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "~") + p.slice(1) : p);
const abspath = (p: string) => (isAbsolute(p) ? pathResolve(p) : pathResolve(process.cwd(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 0-based (line, char) just inside the quoted module string `source` in `file`, or null.
function _module_string_pos(repo: string, file: string, source: string): [number, number] | null {
  let text: string;
  try { text = readFileSync(join(repo, file), "utf-8"); } catch { return null; }
  for (const q of [`"${source}"`, `'${source}'`, `\`${source}\``]) {
    const idx = text.indexOf(q);
    if (idx >= 0) {
      const inside = idx + 2;                        // one char into the string content
      const line0 = text.slice(0, inside).split("\n").length - 1;
      const char = inside - (text.lastIndexOf("\n", inside - 1) + 1);
      return [line0, char];
    }
  }
  return null;
}

export class LspResolver implements Resolver {
  fallback: boolean;
  pool: LspPool;
  readyTimeout: number;
  private ready = new Set<string>();                 // `${language}\0${root}` that have loaded once
  private det: Resolver | null = null;

  constructor(fallback = true, pool?: LspPool, readyTimeout = 25.0) {
    this.fallback = fallback;
    this.pool = pool ?? new LspPool();
    this.readyTimeout = readyTimeout;
  }

  async resolve_module(repo: string, importingFile: string, source: string): Promise<string | null> {
    repo = expanduser(repo);
    let target: string | null = null;
    try { target = await this._lsp(repo, importingFile, source); } catch { target = null; }
    if (target === null && this.fallback) return this._floor(repo, importingFile, source);
    return target;
  }

  // --- LSP path --------------------------------------------------------
  private async _lsp(repo: string, importingFile: string, source: string): Promise<string | null> {
    const [c, spec, root] = await this.pool.client_for(repo, importingFile);
    if (c === null || spec === null) return null;     // unsupported language / server unobtainable
    const uri = this.pool.ensure_open(c, repo, importingFile, spec);
    const pos = _module_string_pos(repo, importingFile, source);
    if (uri === null || pos === null) return null;
    const [line, char] = pos;
    const selfAbs = abspath(join(repo, importingFile));

    const query = async (): Promise<string | null> => {
      for (const t of await c.definition(uri, line, char)) {
        if (abspath(t) === selfAbs) continue;        // the import binding / not-yet-resolved
        const rel = relative(repo, t);
        // node_modules or outside the repo = the EXTERNAL boundary (the floor returns null too)
        if (rel.startsWith("..") || rel.split(sep).includes("node_modules")) continue;
        return rel;
      }
      return null;
    };

    const key = `${spec.language}\0${root}`;
    if (!this.ready.has(key)) {                       // first query absorbs the one-time project index
      const deadline = Date.now() + this.readyTimeout * 1000;
      while (Date.now() < deadline) {
        const r = await query();
        if (r !== null) { this.ready.add(key); return r; }
        await sleep(400);
      }
      this.ready.add(key);                            // give up polling; serve one-shot henceforth
      return null;
    }
    return query();
  }

  // --- exact symbol resolution (P1.5) ----------------------------------
  async resolve_symbol(repo: string, file: string, line: number, col: number): Promise<[string, number] | null> {
    repo = expanduser(repo);
    try {
      const [c, spec, root] = await this.pool.client_for(repo, file);
      if (c === null || spec === null) return null;
      const uri = this.pool.ensure_open(c, repo, file, spec);
      if (uri === null) return null;
      const selfAbs = abspath(join(repo, file));

      const q = async (): Promise<[string, number] | null> => {
        for (const [t, ln] of await c.definition_locs(uri, line, col)) {
          if (abspath(t) === selfAbs) continue;
          const rel = relative(repo, t);
          const parts = rel.split(sep);
          if (rel.startsWith("..") || parts.includes("node_modules") || parts.includes("site-packages")) continue;
          return [rel, ln];
        }
        return null;
      };

      const key = `${spec.language}\0${root}`;
      if (!this.ready.has(key)) {
        const deadline = Date.now() + this.readyTimeout * 1000;
        while (Date.now() < deadline) {
          const r = await q();
          if (r !== null) { this.ready.add(key); return r; }
          await sleep(400);
        }
        this.ready.add(key);
        return null;
      }
      return q();
    } catch { return null; }
  }

  // --- deterministic floor (auto fallback) -----------------------------
  private async _floor(repo: string, importingFile: string, source: string): Promise<string | null> {
    if (this.det === null) { const { DeterministicResolver } = await import("../resolver.js"); this.det = new DeterministicResolver(); }
    return this.det.resolve_module(repo, importingFile, source);
  }
}

// The production resolver (P4): resolve through the persistent daemon's WARM servers — the index is
// paid once per machine, reused by every invocation. Degrades cleanly: daemon unreachable → in-process
// LSP; LSP miss/null + `fallback` → the deterministic floor. Never a hard failure.
export class DaemonResolver implements Resolver {
  fallback: boolean;
  sock: string;
  private lsp: LspResolver | null = null;            // in-process LSP, only if the daemon is down
  private det: Resolver | null = null;

  constructor(fallback = true, sock?: string) {
    this.fallback = fallback;
    this.sock = sock ?? defaultSocket();
  }

  async resolve_module(repo: string, importingFile: string, source: string): Promise<string | null> {
    repo = expanduser(repo);
    let target: string | null;
    try {
      const { call } = await import("./daemon.js");
      target = await call(this.sock, { op: "resolve_module", repo, file: importingFile, source });
    } catch {
      target = await this.inproc().resolve_module(repo, importingFile, source);   // daemon down
    }
    if (target === null && this.fallback) return this._floor(repo, importingFile, source);
    return target;
  }

  async resolve_symbol(repo: string, file: string, line: number, col: number): Promise<[string, number] | null> {
    repo = expanduser(repo);
    try {
      const { call } = await import("./daemon.js");
      const r = await call(this.sock, { op: "resolve_symbol", repo, file, line, col });
      return r ? (r as [string, number]) : null;
    } catch {
      return this.inproc().resolve_symbol(repo, file, line, col);
    }
  }

  private inproc(): LspResolver {
    if (this.lsp === null) this.lsp = new LspResolver(false);
    return this.lsp;
  }

  private async _floor(repo: string, importingFile: string, source: string): Promise<string | null> {
    if (this.det === null) { const { DeterministicResolver } = await import("../resolver.js"); this.det = new DeterministicResolver(); }
    return this.det.resolve_module(repo, importingFile, source);
  }
}

// re-exported so daemon.ts (which imports default_socket) and the resolver share one definition.
export function defaultSocket(): string {
  const base = process.env.XDG_RUNTIME_DIR || (process.env.TMPDIR ?? "/tmp");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(base, `seam-lsp-${uid}.sock`);
}
