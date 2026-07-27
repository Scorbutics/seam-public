// Intent-conditioned shared-subject affinity (SUGGESTED). Spike-validated: over a BROAD shared subject
// (e.g. `Cargo`, touched by booking / tracking / handling / inspection alike) the INTENT cleanly
// separates related work from same-subject noise. Split of labour (per CLAUDE.md): STRUCTURE finds the
// candidates — files that reference the footprint's subjects, co-occurrence-ranked + capped, so the LLM
// never sees the whole repo; the LLM JUDGES intent-affinity. These are SUGGESTED, never asserted edges —
// they surface seams that relate to the intent but aren't reachable by a resolved edge (e.g. DI-wired
// upstream entry points). Off by default (a flag gates the pipeline integration).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAddon as _loadAddon } from "./rust_core.js";
// The def/embedding reads come from the CORE (rust/seam_core.node). Byte-identical to the TypeScript scan
// they replaced — rust/parity/{deftable,defembed}.ts — and this is the last thing that kept `scan/` alive.
import { toResolvedGraph as _toResolvedGraph } from "./rust_core.js";
const _core = (): any => _loadAddon();
import { run_pass_async, registerPass } from "../../core/llm.js";

const PASS = registerPass({ tag: "affinity", tier: "cheap", note: "intent-affinity scoring of shared-subject candidates (SUGGESTED)" });
import { normpath } from "../../core/resolve/walk.js";

export interface AffinityHit { file: string; symbol: string; shared: string[]; confidence: number; reason: string; }
// An affinity hit after the grow-probe: `connected` = a resolved edge links it BACK to the footprint
// (→ promote to RESOLVED, deterministic); else it stays a SUGGESTED affinity. `via` = the footprint
// symbol it connected through.
export interface AffinityResult extends AffinityHit { connected: boolean; via?: string; }

// The file's primary declared type — the symbol to grow a probe from. First class/interface/enum.
function _symbolOf(text: string): string {
  const m = text.match(/\b(?:export\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)/);
  return m ? m[1] : "";
}

// A compact, cheap gist of a file (regex, no parse): its type decl + a couple of method names — enough
// for the LLM to judge purpose without sending the whole file.
function _gist(text: string): string {
  const out: string[] = [];
  const decl = text.match(/\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/);
  if (decl) out.push(decl[0].trim());
  for (const m of text.matchAll(/\b(?:public|protected)\s+(?:static\s+)?[\w<>\[\],.\s]+?\b([a-z]\w*)\s*\(/g)) {
    out.push(m[1] + "()");
    if (out.length >= 3) break;
  }
  return out.join(" · ") || "(no decl)";
}

// Candidate files that reference ≥1 footprint subject, ranked by how many DISTINCT subjects they share
// (co-occurrence — the more of the footprint's subjects a file touches, the likelier it's related), then
// path for determinism. The structural floor; the LLM only ever sees the top `cap`.
function _candidates(repo: string, subjects: string[], exclude: Set<string>, cap: number): { file: string; symbol: string; shared: string[]; gist: string }[] {
  const pats = subjects.filter(Boolean).map((s) => ({ s, re: new RegExp(`\\b${s.replace(/[^\w]/g, "")}\\b`) }));
  const out: { file: string; symbol: string; shared: string[]; gist: string }[] = [];
  for (const rel of _core().candidateSourceFiles(repo) as string[]) {
    if (exclude.has(rel)) continue;
    let text: string;
    try { text = readFileSync(join(repo, rel), "utf-8"); } catch { continue; }
    const shared = pats.filter((p) => p.re.test(text)).map((p) => p.s);
    if (shared.length) out.push({ file: rel, symbol: _symbolOf(text), shared, gist: _gist(text) });
  }
  out.sort((a, b) => b.shared.length - a.shared.length || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out.slice(0, cap);
}

function _prompt(subjects: string[], intent: string, cands: { file: string; shared: string[]; gist: string }[]): string {
  const units = cands.map((c, i) => `${i}\t${c.file} :: ${c.gist}  (shares: ${c.shared.join(", ")})`).join("\n");
  return [
    `These code units all reference shared subjects from a code footprint: ${subjects.join(", ")}.`,
    `They span MANY concerns — touching a subject does NOT make a unit relevant.`,
    ``,
    `INTENT under investigation: "${intent}".`,
    ``,
    `For EACH unit decide: does it do work that is PART OF / DIRECTLY RELEVANT TO that intent — NOT merely`,
    `that it shares a subject? Be strict: a different lifecycle stage, a view/read, a logger/DTO, sample`,
    `data, or an adjacent concern that just happens to touch the same class is NOT related.`,
    ``,
    `Output ONLY a JSON array, one object per RELATED unit (OMIT the unrelated ones entirely):`,
    `[{"id": <unit number>, "confidence": 0..1, "reason": "<=5 words"}]`,
    ``,
    `UNITS:`,
    units,
  ].join("\n");
}

// Run the intent-conditioned affinity pass with SELF-CONSISTENCY VOTING. The single LLM call is noisy on
// borderline intent-relevance (measured: ~44% run-to-run agreement), so cast `votes` ballots and keep
// only candidates a MAJORITY mark related; confidence = vote fraction. The ballots run CONCURRENTLY
// (run_pass_async) so the wall-clock stays ~one pass on the CLI path. SUGGESTED-only; never throws into
// the caller (a footprint must not fail because this best-effort enrichment did).
export async function subject_affinity(repo: string, subjects: string[], intent: string,
    opts: { cap?: number; exclude?: string[]; votes?: number; model?: string; claudeBin?: string | null } = {}): Promise<AffinityHit[]> {
  if (!subjects.length || !intent) return [];
  const cands = _candidates(repo, subjects, new Set(opts.exclude ?? []), opts.cap ?? 30);
  if (!cands.length) return [];
  const votes = Math.max(1, opts.votes ?? 3);
  const prompt = _prompt(subjects, intent, cands);
  const ballots = await Promise.all(Array.from({ length: votes }, () =>
    run_pass_async(prompt, { tag: PASS.tag, thinking: 0, model: opts.model, claudeBin: opts.claudeBin }).catch(() => null)));
  const cast = ballots.filter(Boolean).length;
  if (!cast) return [];
  const tally = new Array(cands.length).fill(0);
  const lastReason = new Array<string>(cands.length).fill("");
  for (const res of ballots) if (res) for (let i = 0; i < cands.length; i++) { const r = res.get(String(i)); if (r) { tally[i]++; lastReason[i] = String(r.reason ?? ""); } }
  const need = Math.ceil(cast / 2);   // strict majority of the ballots actually cast
  const hits: AffinityHit[] = [];
  for (let i = 0; i < cands.length; i++)
    if (tally[i] >= need) hits.push({ file: cands[i].file, symbol: cands[i].symbol, shared: cands[i].shared, confidence: tally[i] / cast, reason: lastReason[i] });
  return hits;
}

// Roadmap step: SEED auto-grow with the affinity hits. For each intent-related hit (found by shared
// subject, NOT by a resolved edge — the footprint is excluded), grow a dependency probe from it and ask
// whether a RESOLVED edge links it BACK to the footprint. Connect-back → `connected` (promote to a real
// edge — precise AND deterministic, so it no longer relies on the fragile LLM judgement); no connect-back
// → it stays a SUGGESTED affinity (the genuinely edge-less, e.g. runtime-DI-only, case). This is the
// recall→verify shape: affinity recalls candidates across boundaries; the deterministic grow confirms them.
export async function affinity_grow(repo: string, subjects: string[], intent: string, footprintFiles: string[],
    opts: { cap?: number; votes?: number; model?: string; claudeBin?: string | null } = {}): Promise<AffinityResult[]> {
  const fset = new Set(footprintFiles.map((f) => normpath(f)));
  const hits = await subject_affinity(repo, subjects, intent, { ...opts, exclude: footprintFiles });
  const out: AffinityResult[] = [];
  for (const h of hits) {
    let connected = false, via: string | undefined;
    if (h.symbol) {
      try {
        const probe = _toResolvedGraph(_core().buildFootprint(repo, h.file, h.symbol, "down", false, null, null, null));
        const back = (probe.nodes ?? []).find((n: any) => n.id !== "n1" && n.file && fset.has(normpath(n.file)));
        if (back) { connected = true; via = back.symbol; }
      } catch { /* probe failed → stays SUGGESTED, honest */ }
    }
    out.push({ ...h, connected, via });
  }
  return out;
}
