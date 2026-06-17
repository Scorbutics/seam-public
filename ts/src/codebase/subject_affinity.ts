// Intent-conditioned shared-subject affinity (SUGGESTED). Spike-validated: over a BROAD shared subject
// (e.g. `Cargo`, touched by booking / tracking / handling / inspection alike) the INTENT cleanly
// separates related work from same-subject noise. Split of labour (per CLAUDE.md): STRUCTURE finds the
// candidates — files that reference the footprint's subjects, co-occurrence-ranked + capped, so the LLM
// never sees the whole repo; the LLM JUDGES intent-affinity. These are SUGGESTED, never asserted edges —
// they surface seams that relate to the intent but aren't reachable by a resolved edge (e.g. DI-wired
// upstream entry points). Off by default (a flag gates the pipeline integration).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { candidate_source_files } from "./def_table.js";
import { run_pass } from "../core/llm.js";

export interface AffinityHit { file: string; shared: string[]; confidence: number; reason: string; }

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
function _candidates(repo: string, subjects: string[], exclude: Set<string>, cap: number): { file: string; shared: string[]; gist: string }[] {
  const pats = subjects.filter(Boolean).map((s) => ({ s, re: new RegExp(`\\b${s.replace(/[^\w]/g, "")}\\b`) }));
  const out: { file: string; shared: string[]; gist: string }[] = [];
  for (const rel of candidate_source_files(repo)) {
    if (exclude.has(rel)) continue;
    let text: string;
    try { text = readFileSync(join(repo, rel), "utf-8"); } catch { continue; }
    const shared = pats.filter((p) => p.re.test(text)).map((p) => p.s);
    if (shared.length) out.push({ file: rel, shared, gist: _gist(text) });
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

// Run the intent-conditioned affinity pass. ONE LLM call. Returns the related hits (SUGGESTED). Never
// throws into the caller — a footprint must not fail because this best-effort enrichment did.
export function subject_affinity(repo: string, subjects: string[], intent: string,
    opts: { cap?: number; exclude?: string[]; model?: string; claudeBin?: string | null } = {}): AffinityHit[] {
  if (!subjects.length || !intent) return [];
  const cands = _candidates(repo, subjects, new Set(opts.exclude ?? []), opts.cap ?? 30);
  if (!cands.length) return [];
  let res: Map<string, any>;
  try { res = run_pass(_prompt(subjects, intent, cands), { tag: "affinity", thinking: 0, model: opts.model, claudeBin: opts.claudeBin }); }
  catch { return []; }
  const hits: AffinityHit[] = [];
  for (let i = 0; i < cands.length; i++) {
    const r = res.get(String(i));
    if (r) hits.push({ file: cands[i].file, shared: cands[i].shared, confidence: Number(r.confidence ?? 0.5), reason: String(r.reason ?? "") });
  }
  return hits;
}
