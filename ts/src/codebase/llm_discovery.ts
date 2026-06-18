// Port of src/codebase/llm_discovery.py — tier-3 of the edge ladder: LLM DISCOVERY → SUGGESTED.
// The LLM proposes couplings a symbol/string scan misses (dispatch keys, config keys, conventions);
// every proposal is GROUNDED to a real repo path or dropped. SUGGESTED candidates only, never edges.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { run_pass, ClassifierError as LLMError } from "../core/llm.js";
import { module_entry_index } from "./string_coupling.js";
import { normPath } from "./coupling/adapters/http_route.js";
import { SKIP_DIRS, endsWithSourceExt } from "../core/resolve/languages/index.js";
import { walk } from "../core/resolve/walk.js";

function buildPrompt(file: string, snippet: string, resolved: string): string {
  return `You are analysing ONE function to find COUPLINGS to OTHER parts of this codebase that a static
import/symbol analysis CANNOT see — couplings carried by a STRING, runtime dispatch, a config key, an
event/topic name, a framework convention, or dynamic loading. NOT ordinary imports/calls.

FUNCTION (file: ${file}):
${snippet}

PUB/SUB & MESSAGING: if this function PUBLISHES/FIRES/EMITS an event or message (any framework — a CDI
event, a Spring publisher, an event bus, a JMS/queue send), the coupled target is the code that
HANDLES/SUBSCRIBES TO it; if it HANDLES/RECEIVES one, the target is the EMITTER. Name that handler/emitter
file. The link is the event TYPE or topic/destination name.

ALREADY RESOLVED — do NOT repeat these targets:
${resolved}

Output ONLY couplings with CONCRETE textual evidence in the function above. For each, give the TARGET
it couples to: a name or path that should EXIST somewhere in this repo (a module/file/dir/function).
Do NOT invent targets — if you are not pointing at something that plausibly exists in the repo, omit
it. A wrong guess is worse than silence.

Return a JSON array, one object per coupling (empty array if none):
[{"id":"c1","target":"<repo name or path the evidence refers to>","evidence":"<the literal/snippet>"}]
`;
}

const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

function _ground(repo: string, target: string, entryIndex: Map<string, string[]>): string | null {
  if (!target) return null;
  const t = target.trim().replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
  const base = stem(t);
  const hits = entryIndex.get(base) ?? entryIndex.get(t);
  if (hits && hits.length === 1) return hits[0];
  if (isFile(join(repo, t))) return t;
  const matches: string[] = [];
  for (const [dir, files] of walk(repo, SKIP_DIRS)) {
    for (const f of files) {
      if (stem(f) === base && endsWithSourceExt(f)) {   // any supported language (registry-sourced), not just JS/Py — so a cross-stack proposal can ground to a .java/.rb/.c backend
        matches.push(relative(repo, join(dir, f)));
        if (matches.length > 1) return null;
      }
    }
  }
  return matches.length ? matches[0] : null;
}

// Tier-3, SHARED-KEY front-end: the LLM names data-flow KEYS this function produces/consumes (DB
// tables, queue/topic/event names, route paths) — cross-framework, where the deterministic adapters
// (Supabase regex etc.) are blind. Each proposal grounds through the coupling shared_key_index, so
// the LLM and the regex floor feed the SAME boundary machinery. Returns {kind, value, produces}.
function buildKeyPrompt(file: string, snippet: string): string {
  return `You are analysing ONE function for DATA-FLOW couplings carried by a SHARED KEY — an identifier
it shares with OTHER files that no import or call connects: a DB table, a queue/topic name, an event
name, a cache key, an HTTP route path. NOT ordinary imports/calls.

FUNCTION (file: ${file}):
${snippet}

For each shared key with CONCRETE textual evidence above, give:
  kind  — one of: db-table | queue | event | route | cache | key
  value — the literal name (the table/topic/event-type/route string)
  role  — "produces" if this function WRITES/EMITS/PUBLISHES/FIRES it, "consumes" if it READS/SUBSCRIBES-TO/HANDLES it
          (for an event/queue: emitting = produces, an @Observes/@EventListener/onMessage handler = consumes)
Do NOT invent keys — only ones literally present. A wrong guess is worse than silence.

Return a JSON array, one object per key (empty array if none):
[{"id":"k1","kind":"db-table","value":"payments","role":"produces"}]
`;
}

// The LLM's free-text kind vocabulary (buildKeyPrompt) → the engine's registered adapter kinds. The
// HTTP-route adapter keys on `http-route`, but the prompt (and the model) naturally say "route" / a few
// near-synonyms; without this, an LLM-proposed backend route would miss the index and die as an
// `llm-proposed-key` blindspot instead of grounding to the (adapter-indexed) front-end fetch callers.
const _KIND_ALIASES: Record<string, string> = { route: "http-route", endpoint: "http-route", http: "http-route", url: "http-route", path: "http-route" };
const _canon_kind = (k: string): string => _KIND_ALIASES[k.toLowerCase()] ?? k;

export function discover_keys(repo: string, anchorFile: string, fileText: string, lo: number, hi: number,
    opts: { model?: string; claudeBin?: string | null } = {}): { kind: string; value: string; produces: boolean }[] {
  const snippet = fileText.split("\n").slice(lo, hi + 1).join("\n").slice(0, 4000);
  if (!snippet.trim()) return [];
  let out: Map<string, any>;
  try { out = run_pass(buildKeyPrompt(anchorFile, snippet), { model: opts.model, claudeBin: opts.claudeBin, tag: "discover-keys" }); }
  catch (e) { if (e instanceof LLMError) return []; throw e; }
  const keys: { kind: string; value: string; produces: boolean }[] = [];
  const seen = new Set<string>();
  for (const obj of out.values()) {
    if (!obj || typeof obj !== "object") continue;
    const kind = _canon_kind(String(obj.kind ?? "").trim());
    let value = String(obj.value ?? "").trim();
    if (!kind || !value) continue;
    if (kind === "http-route") value = normPath(value);   // meet the floor's normalised route key (`{id}`/`:id`/`[id]` → `*`)
    const produces = String(obj.role ?? "").trim().toLowerCase().startsWith("produc");
    const k = `${kind} ${value} ${produces}`;
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push({ kind, value, produces });
  }
  return keys;
}

export function discover(repo: string, anchorFile: string, fileText: string, lo: number, hi: number,
    resolvedFiles: string[], opts: { model?: string; claudeBin?: string | null } = {}): any[] {
  const snippet = fileText.split("\n").slice(lo, hi + 1).join("\n").slice(0, 4000);
  if (!snippet.trim()) return [];
  const prompt = buildPrompt(anchorFile, snippet, [...new Set(resolvedFiles)].sort().join(", ") || "(none)");
  let out: Map<string, any>;
  try { out = run_pass(prompt, { model: opts.model, claudeBin: opts.claudeBin, tag: "discover" }); }
  catch (e) { if (e instanceof LLMError) return []; throw e; }
  const entryIndex = module_entry_index(repo, SKIP_DIRS);
  const cands: any[] = [];
  const seen = new Set<string>();
  for (const obj of out.values()) {
    if (!obj || typeof obj !== "object") continue;
    const grounded = _ground(repo, String(obj.target ?? ""), entryIndex);
    if (grounded && grounded !== anchorFile && !resolvedFiles.includes(grounded) && !seen.has(grounded)) {
      seen.add(grounded);
      cands.push({ file: grounded, evidence: String(obj.evidence ?? "").slice(0, 160), provenance: "SUGGESTED" });
    }
  }
  return cands;
}
