// Port of src/core/resolve/lsp/pool.py — one warm server per (language, project-root), started
// lazily and reused for every query, shut down at process exit. This is what turns the one-time
// project index (~5.5s for TS) into a once-per-session cost. A server that can't be obtained/started
// yields null, so the caller degrades to the deterministic floor — never a hard failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LspClient, LspError } from "./client.js";
import { spec_for_file, language_id_for, project_root } from "../languages/index.js";
import type { ServerSpec } from "../languages/base.js";

const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "~") + p.slice(1) : p);

export class LspPool {
  private clients = new Map<string, LspClient | null>();   // `${language}\0${root}` -> client | null
  private open = new Set<string>();                          // `${clientUid}\0${uri}`
  private uid = 0;
  private uids = new WeakMap<LspClient, number>();
  private registered = false;

  constructor() {
    if (!this.registered) { this.registered = true; process.once("exit", () => this.shutdown_all()); }
  }

  private uidOf(c: LspClient): number {
    let u = this.uids.get(c);
    if (u === undefined) { u = ++this.uid; this.uids.set(c, u); }
    return u;
  }

  // [client | null, spec | null, root]. A null client ⇒ unsupported lang / server unobtainable.
  async client_for(repo: string, file: string): Promise<[LspClient | null, ServerSpec | null, string]> {
    const spec = spec_for_file(file);
    if (spec === null) return [null, null, repo];
    const root = project_root(repo, file, spec);
    const key = `${spec.language}\0${root}`;
    if (!this.clients.has(key)) this.clients.set(key, await this.start(spec, root));
    return [this.clients.get(key) ?? null, spec, root];
  }

  private async start(spec: ServerSpec, root: string): Promise<LspClient | null> {
    const cmd = spec.command(root);
    if (!cmd) return null;                            // server binary not obtainable on this machine
    const env = { ...process.env };
    env.PATH = expanduser("~/.bun/bin") + (process.platform === "win32" ? ";" : ":") + (env.PATH ?? "");
    try {
      const c = new LspClient(cmd, root, env);
      await c.initialize("file://" + root, spec.initOptions ? spec.initOptions(root) : {});
      return c;
    } catch (e) {
      if (e instanceof LspError) return null;
      throw e;
    }
  }

  ensure_open(c: LspClient, repo: string, file: string, spec: ServerSpec): string | null {
    const uri = "file://" + join(repo, file);
    const k = `${this.uidOf(c)}\0${uri}`;
    if (!this.open.has(k)) {
      let text: string;
      try { text = readFileSync(join(repo, file), "utf-8"); } catch { return null; }
      c.did_open(uri, language_id_for(spec, file), text);
      this.open.add(k);
    }
    return uri;
  }

  shutdown_all(): void {
    for (const c of this.clients.values()) if (c !== null) { try { c.shutdown(); } catch { /* ignore */ } }
    this.clients.clear();
    this.open.clear();
  }
}
