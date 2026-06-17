// Solution #1 — SEMANTIC route/entry-point selection. The lexical recall net (anchor_rank) keys on the
// symbol NAME, so a convention-named handler (`POST`) or an anonymous edge function (`Deno.serve(…)`)
// is invisible — even though the domain is in the PATH (`/api/admin/invite-members`, `stripe-webhook`).
// The reverted lexical-candidate approach failed because routes COMPETED in the pool and the
// footprint-judge got seduced by any path that lexically matched ("member-email" for "email
// notification"). This instead: deterministically ENUMERATE the entry-point paths (structure), then ask
// the LLM which path the intent is SPECIFICALLY about (meaning) — returning `none` for behavior/service
// intents so it never overrides a good service anchor. Structure enumerates; the LLM judges; no lexical
// pool pollution. The chosen handler is anchored on its FILE — its imports seed the downstream, which
// the direction-aware grow traces (so an anonymous edge handler needs no symbol).
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { run_pass_async, ClassifierError as LLMError } from "../core/llm.js";
import { walk } from "../core/resolve/walk.js";
import { endsWithSourceExt, SKIP_DIRS } from "../core/resolve/languages/index.js";
import { scan_file_keys, complement_unit } from "./coupling/index.js";

export interface EntryPoint { path: string; file: string; line: number; }

const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);

// Cheap enumeration: ALL HTTP entry points come from the http_route coupling adapter (`scan_file_keys`)
// — Next route handlers AND Supabase/Deno edge functions, each as a `produces` http-route hit with its
// served path + the anchor line. Framework conventions live in the adapter (the registry), not here.
// NO tree-sitter here — the handler symbol is resolved only AFTER the pick.
export function enumerate_entrypoints(repo: string, limit = 300): EntryPoint[] {
  repo = expanduser(repo);
  const out: EntryPoint[] = [];
  const seen = new Set<string>();
  for (const [dir, files] of walk(repo, SKIP_DIRS)) {
    for (const fn of files) {
      if (!endsWithSourceExt(fn)) continue;
      const abs = join(dir, fn);
      const rel = relative(repo, abs).replace(/\\/g, "/");
      let text: string;
      try { text = readFileSync(abs, "utf-8"); } catch { continue; }
      for (const h of scan_file_keys(rel, text)) {
        if (h.kind !== "http-route" || !h.produces) continue;
        const k = `${h.value}#${h.line}#${rel}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ path: h.value, file: rel, line: h.line });
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// One LLM pass: which enumerated endpoint is the intent SPECIFICALLY about — or `none`. Conservative by
// construction (the prompt biases to `none` for behavior/service intents) so it can't override a good
// service anchor. Returns the chosen EntryPoint or null (none / no backend / unusable).
export async function select_entrypoint_llm(intent: string, eps: EntryPoint[],
    opts: { model?: string; claudeBin?: string | null } = {}): Promise<EntryPoint | null> {
  if (!eps.length) return null;
  const shown = eps.slice(0, 150);
  const lines = [
    `A developer asks: "${intent}".`,
    "",
    "Below are the HTTP entry points in this codebase (id: endpoint — file). Each is a route/URL or a",
    "serverless (edge) function:",
  ];
  shown.forEach((e, i) => lines.push(`  e${i}: ${e.path} (${e.file})`));
  lines.push(
    "",
    "Is the question SPECIFICALLY about how ONE of these endpoints works — a named webhook, a specific",
    "route/URL, the API endpoint the question points at?",
    "If the intent is a general BEHAVIOR, a service, or a concept NOT tied to a single endpoint (e.g.",
    '"how does email notification work", "how is auth enforced"), answer "none" — do NOT force a match.',
    'Output ONLY a JSON array with one object: [{"id":"e<N>"}] or [{"id":"none"}]');
  let out: Map<string, any>;
  try { out = await run_pass_async(lines.join("\n"), { model: opts.model, claudeBin: opts.claudeBin, tag: "entrypoint-select" }); }
  catch (e) { if (e instanceof LLMError) return null; throw e; }
  for (const v of out.values()) {
    const id = String(v?.id ?? "").trim();
    if (id === "none") return null;
    const m = /^e(\d+)$/.exec(id);
    if (m && shown[+m[1]]) return shown[+m[1]];
  }
  return null;
}

// Resolve the anchor for a chosen entry point via the coupling registry's `complement_unit`: a named
// handler → its real export symbol (GET/POST); an anonymous handler (an edge `Deno.serve` callback) →
// `complement_unit` falls back to a module, so we anchor on the path SLUG (which won't resolve to a
// unit, but the file's imports seed the downstream the grow follows). Returns [anchorFile, symbol].
export async function entrypoint_anchor(repo: string, ep: EntryPoint): Promise<[string, string]> {
  const slug = ep.path.split("/").filter(Boolean).pop() || ep.path;
  const unit = await complement_unit(expanduser(repo), ep.file, ep.line);
  return [ep.file, unit.kind === "module" ? slug : (unit.symbol || slug)];
}
