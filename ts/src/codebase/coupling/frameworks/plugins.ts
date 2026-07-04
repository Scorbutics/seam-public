// PLUGIN LOADER (Phase 2) — two community extension points for framework support, resolved ONCE at startup:
//   • DECLARATIVE manifest `frameworks.json` — route-annotation VOCABULARY → registerRouteAnnotations. Data
//     only, no code execution; the 80% case (a framework is mostly "which annotations declare a route + verb").
//   • CODE adapters `plugins/*.{mjs,cjs,js}` — each default-exports a `KeyKind` (or exports `ADAPTER`) →
//     registerAdapter. The 20% (novel structural shapes an annotation table can't express).
//
// SECURITY: a code plugin runs arbitrary JS in the engine, so it loads ONLY from the USER-GLOBAL, trusted dir
// (`~/.config/seam/`) by default. A REPO-LOCAL dir (`<repo>/.seam/`) is NOT trusted — a repo you clone could
// ship a malicious plugin that executes the moment you run Seam on it — so repo-local CODE plugins require an
// explicit `SEAM_REPO_PLUGINS=1` opt-in + a stderr warning. The declarative manifest (data) is safe either way.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import type { KeyKind } from "../types.js";
import { registerAdapter } from "../adapters/index.js";
import { registerRouteAnnotations, type RouteAnnotation } from "./route_annotations.js";
import { registerHttpClients, type HttpClient } from "./http_clients.js";
import { registerOrmMethods, type OrmMethod } from "./orm_methods.js";

const userRoot = (): string => { const e = process.env.SEAM_CONFIG_HOME; return e && e.trim() ? e : join(homedir(), ".config", "seam"); };

let _loaded = false;
export function _resetPluginsLoaded(): void { _loaded = false; }

// Load declarative + code plugins from the trusted user root (always) and the repo root (data always; code only
// under SEAM_REPO_PLUGINS=1). Idempotent per process. Never throws — a broken plugin is warned and skipped.
export async function loadFrameworkPlugins(repo: string): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  const repoCode = process.env.SEAM_REPO_PLUGINS === "1";
  const roots: { dir: string; trusted: boolean }[] = [
    { dir: userRoot(), trusted: true },
    { dir: join(repo, ".seam"), trusted: repoCode },   // repo manifests (data) always load; repo CODE only if trusted
  ];
  for (const { dir, trusted } of roots) {
    _loadManifest(join(dir, "frameworks.json"));              // DATA — safe from any root
    if (trusted) await _loadCodeAdapters(join(dir, "plugins"));   // CODE — trusted roots only
    else if (existsSync(join(dir, "plugins")) && !process.env.SEAM_REPO_PLUGINS)
      process.stderr.write(`[plugins] ${join(dir, "plugins")} has code adapters — NOT loaded (untrusted repo dir). Set SEAM_REPO_PLUGINS=1 to allow.\n`);
  }
}

function _loadManifest(path: string): void {
  if (!existsSync(path)) return;
  try {
    const j = JSON.parse(readFileSync(path, "utf-8"));
    const anns = (j.routeAnnotations ?? []) as RouteAnnotation[];
    const validAnns = anns.filter((a) => a && typeof a.annotation === "string");
    if (validAnns.length) registerRouteAnnotations(validAnns);
    const clients = (j.httpClients ?? []) as HttpClient[];
    const validClients = clients.filter((c) => c && typeof c.name === "string");
    if (validClients.length) registerHttpClients(validClients);
    const orm = (j.ormMethods ?? []) as OrmMethod[];
    const validOrm = orm.filter((o) => o && typeof o.method === "string" && (o.role === "read" || o.role === "write"));
    if (validOrm.length) registerOrmMethods(validOrm);
  } catch (e) { process.stderr.write(`[plugins] skipped invalid manifest ${path}: ${(e as Error).message}\n`); }
}

async function _loadCodeAdapters(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /\.(mjs|cjs|js)$/.test(f)).sort(); } catch { return; }
  for (const f of files) {
    const full = join(dir, f);
    try {
      const mod: any = await import(pathToFileURL(full).href);
      const adapter: KeyKind | undefined = mod.default ?? mod.ADAPTER;
      if (adapter && typeof adapter.scan === "function" && typeof adapter.kind === "string") {
        if (registerAdapter(adapter)) process.stderr.write(`[plugins] loaded code adapter '${adapter.name ?? adapter.kind}' from ${full}\n`);
      } else process.stderr.write(`[plugins] ${full} exports no KeyKind (default/ADAPTER with kind+scan) — skipped\n`);
    } catch (e) { process.stderr.write(`[plugins] failed to load ${full}: ${(e as Error).message}\n`); }
  }
}

// used by tests to load a specific dir directly, bypassing the once-guard
export const _loadManifestFrom = _loadManifest;
export const _loadCodeAdaptersFrom = _loadCodeAdapters;
