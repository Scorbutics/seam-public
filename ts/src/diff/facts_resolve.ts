// Port of src/diff/facts_resolve.py — ResolvedFactsProvider: enrich a base provider's HunkFacts
// with codebase-resolved references. For each (symbol, source) a hunk imports-and-uses but defines
// nowhere in the diff, resolve the import source against the repo (active resolver / floor) and
// record the target on HunkFacts.resolved_refs — purely additively.
import { _resolve } from "../core/resolve/consumers.js";
import { normpath } from "../core/resolve/walk.js";
import type { FactsProvider, HunkFacts } from "./facts.js";
import type { Hunk } from "./parser.js";
import { external_refs } from "./symbol_edges.js";

const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);

export class ResolvedFactsProvider implements FactsProvider {
  private base: FactsProvider;
  private repo: string | null;
  constructor(base: FactsProvider, repo: string | null | undefined) {
    this.base = base;
    this.repo = repo ? expanduser(repo) : null;
  }
  facts(hunks: Hunk[]): Map<string, HunkFacts> {
    const out = this.base.facts(hunks);
    if (!this.repo) return out;
    const refs = external_refs(hunks);
    for (const h of hunks) {
      const hf = out.get(h.id);
      if (!hf) continue;
      const resolved: Record<string, string> = {};
      for (const r of refs.get(h.id) ?? []) {
        const tgt = _resolve(this.repo, h.file_path, r.source);
        if (tgt) resolved[r.symbol] = normpath(tgt);
      }
      if (Object.keys(resolved).length) hf.resolved_refs = resolved;
    }
    return out;
  }
}
