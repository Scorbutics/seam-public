// Port of src/core/resolve/lsp/client.py — a generic, language-agnostic LSP client (JSON-RPC over a
// server's stdio). Zero stack knowledge: it speaks initialize / textDocument/didOpen /
// textDocument/definition and auto-replies to the server→client requests (workspace/configuration,
// capability registration) that would otherwise hang it. The per-language bits live in languages/.
//
// Node I/O is async, so request()/initialize()/definition* are async (the Python client blocks on a
// threading.Condition; here we resolve a Promise when the matching id arrives).
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Writable, Readable } from "node:stream";

export class LspError extends Error {}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; }

export class LspClient {
  private p: ChildProcessByStdio<Writable, Readable, null>;
  private _id = 0;
  private pending = new Map<number, Pending>();
  private alive = true;
  private buf: Buffer = Buffer.alloc(0);

  constructor(command: string[], cwd: string, env?: NodeJS.ProcessEnv) {
    try {
      // detached ⇒ the server (and any child it spawns, e.g. `bun x` → the real server) is in its OWN
      // process group, so shutdown can kill the WHOLE group — no orphaned servers.
      this.p = spawn(command[0], command.slice(1), {
        cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "ignore"], detached: true,
      });
    } catch (e) {
      throw new LspError(`could not start LSP server ${JSON.stringify(command)}: ${(e as Error).message}`);
    }
    this.p.on("error", () => { this.fail(); });
    this.p.on("exit", () => { this.fail(); });
    this.p.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private fail(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const [, w] of this.pending) { clearTimeout(w.timer); w.reject(new LspError("LSP server exited")); }
    this.pending.clear();
  }

  // --- framing ---------------------------------------------------------
  private send(msg: Record<string, unknown>): void {
    const data = Buffer.from(JSON.stringify(msg), "utf-8");
    try {
      this.p.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${data.length}\r\n\r\n`, "ascii"), data]));
    } catch (e) {
      throw new LspError(`LSP server pipe closed: ${(e as Error).message}`);
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buf.slice(0, sep).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = this.buf.slice(sep + 4); continue; }  // not a framed message; skip the header
      const n = parseInt(m[1], 10);
      const start = sep + 4;
      if (this.buf.length < start + n) return;                    // body not fully arrived yet
      const body = this.buf.slice(start, start + n);
      this.buf = this.buf.slice(start + n);
      let parsed: any;
      try { parsed = JSON.parse(body.toString("utf-8")); } catch { continue; }
      this.dispatch(parsed);
    }
  }

  private dispatch(body: any): void {
    if ("id" in body && "method" in body) {
      // server→client REQUEST → must reply or it hangs. workspace/configuration wants one item per
      // requested config; everything else gets a null result.
      const res = body.method === "workspace/configuration"
        ? new Array((body.params?.items ?? []).length).fill(null) : null;
      this.send({ jsonrpc: "2.0", id: body.id, result: res });
    } else if ("id" in body) {                                    // a response to one of our requests
      const w = this.pending.get(body.id);
      if (w) { clearTimeout(w.timer); this.pending.delete(body.id); w.resolve(body); }
    }
    // else: a server→client NOTIFICATION (diagnostics, progress) — ignored.
  }

  // --- RPC -------------------------------------------------------------
  request(method: string, params: Record<string, unknown>, timeout = 60.0): Promise<any> {
    if (!this.alive) return Promise.reject(new LspError("LSP server exited"));
    const rid = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new LspError(`LSP request timed out: ${method}`)); }, timeout * 1000);
      this.pending.set(rid, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id: rid, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(rid); reject(e as Error); }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  // --- convenience -----------------------------------------------------
  async initialize(rootUri: string, initOptions?: Record<string, unknown>): Promise<void> {
    await this.request("initialize", {
      processId: process.pid, rootUri,
      capabilities: { window: { workDoneProgress: true } },
      workspaceFolders: [{ uri: rootUri, name: "root" }],
      initializationOptions: initOptions ?? {},
    });
    this.notify("initialized", {});
  }

  did_open(uri: string, languageId: string, text: string): void {
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
  }

  // go-to-definition → [(target file, 0-based def line)], order-preserving.
  async definition_locs(uri: string, line: number, char: number, timeout = 12.0): Promise<[string, number][]> {
    const r = await this.request("textDocument/definition", {
      textDocument: { uri }, position: { line, character: char },
    }, timeout);
    let locs = r.result ?? [];
    locs = Array.isArray(locs) ? locs : [locs];
    const out: [string, number][] = [];
    for (const l of locs) {
      if (!l) continue;
      const u = String(l.uri ?? l.targetUri ?? "").replace(/^file:\/\//, "");
      const rng = l.range ?? l.targetSelectionRange ?? l.targetRange ?? {};
      const ln = Math.trunc((rng.start ?? {}).line ?? 0);
      if (u) out.push([u, ln]);   // no URI-decode (matches the Python client's plain .replace)
    }
    return out;
  }

  // go-to-definition → list of repo-absolute target file paths (deduped, order-preserving).
  async definition(uri: string, line: number, char: number, timeout = 30.0): Promise<string[]> {
    const out: string[] = [];
    for (const [u] of await this.definition_locs(uri, line, char, timeout)) if (!out.includes(u)) out.push(u);
    return out;
  }

  shutdown(): void {
    this.alive = false;
    try { this.notify("exit", {}); } catch { /* ignore */ }
    try {                                            // kill the whole process group (server + children)
      if (this.p.pid) process.kill(-this.p.pid, "SIGTERM");
    } catch {
      try { this.p.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }
}
