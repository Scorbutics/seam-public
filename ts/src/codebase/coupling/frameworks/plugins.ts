// PLUGIN LOADER (Phase 2) — the community extension point for framework support, resolved ONCE at startup.
//
// A DECLARATIVE manifest `frameworks.json` teaches the floor a framework it does not know: which annotations
// declare a route (and the verb), which ORM methods read vs write, which receivers are http clients. Data
// only, no code execution — the 80% case, since "supporting a framework" is mostly vocabulary.
//
// REGISTRATION GOES TO THE CORE, which is what scans. This module used to register into TypeScript tables
// beside it, and those tables have no reader left: the floor is `seam-couple`. The manifest therefore loaded,
// validated, "registered", and changed NOTHING — measurable as a route annotation whose declared HTTP verb
// never reached the scanned key, so a GET consumer could pair with a POST handler. The tests were green
// throughout because they asserted against the same unread tables.
//
// SECURITY: the manifest is DATA and loads from any root. Code adapters are a different matter — see the note
// on `_loadCodeAdapters` below; they are no longer loadable at all, and say so loudly.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadAddon } from "../../rust_core.js";

// The manifest's wire shape. `framework`/`orm` provenance labels are documentation, never matched on, so they
// are read and dropped; what crosses to the core is the vocabulary itself.
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
export interface RouteAnnotation { annotation: string; httpMethod?: HttpMethod; framework?: string }
export interface HttpClient { name: string; verbForms?: boolean; framework?: string }
export interface OrmMethod { method: string; role: "read" | "write"; orm?: string }

const userRoot = (): string => { const e = process.env.SEAM_CONFIG_HOME; return e && e.trim() ? e : join(homedir(), ".config", "seam"); };

let _loaded = false;

// Load declarative manifests from the trusted user root and the repo root (data is safe from either).
// Idempotent per process. Never throws — a broken manifest is warned and skipped.
export async function loadFrameworkPlugins(repo: string): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  for (const dir of [userRoot(), join(repo, ".seam")]) {
    _loadManifest(join(dir, "frameworks.json"));
    await _loadCodeAdapters(join(dir, "plugins"));
  }
}

function _loadManifest(path: string): void {
  if (!existsSync(path)) return;
  try {
    const j = JSON.parse(readFileSync(path, "utf-8"));
    const core = loadAddon();
    if (!core) return;   // no addon → nothing scans, so nothing to teach
    for (const a of (j.routeAnnotations ?? []) as RouteAnnotation[])
      if (a && typeof a.annotation === "string") core.registerRouteAnnotation(a.annotation, a.httpMethod ?? undefined);
    // The core gives every REGISTERED client verb-form tolerance (`api.get(…)` as well as `api(…)`), so a
    // manifest's `verbForms: false` is not honoured. That is the core's documented treatment of a non-builtin
    // receiver and it is the permissive direction — it recognises more calls, never fewer.
    const clients = ((j.httpClients ?? []) as HttpClient[]).filter((c) => c && typeof c.name === "string").map((c) => c.name);
    if (clients.length) core.registerHttpClients(clients);
    for (const o of (j.ormMethods ?? []) as OrmMethod[])
      if (o && typeof o.method === "string" && (o.role === "read" || o.role === "write")) core.registerOrmMethod(o.method, o.role === "write");
  } catch (e) { process.stderr.write(`[plugins] skipped invalid manifest ${path}: ${(e as Error).message}\n`); }
}

// CODE ADAPTERS ARE NO LONGER LOADABLE. A code plugin is a JavaScript module exporting a full `KeyKind`
// (its own `scan`), registered at runtime as a live adapter. The floor that scans is the Rust core now, and a
// JS module cannot extend it — this is a capability LOSS, not a deferral, and reinstating it needs a different
// design (a WASM adapter ABI, or a declarative shape rich enough that code is unnecessary).
//
// It stays a loud WARNING rather than a silent no-op: a user who dropped an adapter into their plugins dir
// must be told it is inert, not left to conclude their coupling simply is not there. Because nothing is
// executed, the load is no longer trust-sensitive — the old `SEAM_REPO_PLUGINS=1` gate guarded against a
// cloned repo running arbitrary JS, and there is no longer any JS to run.
async function _loadCodeAdapters(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /\.(mjs|cjs|js)$/.test(f)).sort(); } catch { return; }
  if (files.length) process.stderr.write(`[plugins] ${files.length} code adapter(s) in ${dir} are NOT loaded: code plugins are unsupported against the Rust floor. Use a declarative frameworks.json manifest instead.\n`);
}

// used by tests to load a specific dir directly, bypassing the once-guard
export const _loadManifestFrom = _loadManifest;
export const _loadCodeAdaptersFrom = _loadCodeAdapters;
