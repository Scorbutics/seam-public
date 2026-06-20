// Port of src/codebase/llm_discovery.py — tier-3 of the edge ladder: LLM DISCOVERY → SUGGESTED.
// The LLM proposes couplings a symbol/string scan misses (dispatch keys, config keys, conventions);
// every proposal is GROUNDED to a real repo path or dropped. SUGGESTED candidates only, never edges.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { run_pass, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { module_entry_index } from "./string_coupling.js";

const PASS = registerPass({ tag: "discover", tier: "cheap", note: "discover cross-file string-coupling edges (SUGGESTED)" });
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";
import { walk } from "../../core/resolve/walk.js";

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

// NOTE: the per-function shared-KEY LLM front-end (`discover_keys`) was removed (2026-06-19). The key
// axis is now the repo-wide, batched, cached `coupling/llm_key_index` (its own prompt/vocab); the anchor's
// keys come from that index. This module keeps the file-coupling `discover` tier-3 below.

export function discover(repo: string, anchorFile: string, fileText: string, lo: number, hi: number,
    resolvedFiles: string[], opts: { model?: string; claudeBin?: string | null } = {}): any[] {
  const snippet = fileText.split("\n").slice(lo, hi + 1).join("\n").slice(0, 4000);
  if (!snippet.trim()) return [];
  const prompt = buildPrompt(anchorFile, snippet, [...new Set(resolvedFiles)].sort().join(", ") || "(none)");
  let out: Map<string, any>;
  try { out = run_pass(prompt, { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag }); }
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
