// INTENT KEY RANKER — scores a shared key by relevance to the intent from THREE signals, taking the MAX so a
// key survives if ANY of them says "relevant" (we only demote keys irrelevant by every measure → an
// inoffensive blindspot):
//   1. VALUE        — the key name. Cheap, but weak for generic keys (`input`, `click`).
//   2. OTHER SIDE   — the file paths it couples to (where it LEADS). Known from the index BEFORE any
//                     tree-sitter materialization, so we look at the other side without paying the hop.
//   3. PASSAGE      — the code around the key's USE in this file. A generic `$emit('input')` inside
//                     `updateParaplanningField()` is relevant HERE; the local context captures that.
// All embedded as short strings (cached); only invoked when a node hits the fan cap. Used as the
// EngineCtx.rankKeys callback so coupling stays a DAG leaf (no embedding import).
import { embedScoreStrings } from "../scan/def_embed.js";

export interface KeyRankItem { value: string; otherSide: string[]; passage?: string }

const _OTHER_SIDE_SAMPLE = 8;                                    // bound the embeds per key (paths are cached)
const _pathText = (f: string) => f.replace(/[/_.\-]+/g, " ").trim();   // path → domain words for embedding

export function makeIntentKeyRanker(intent: string): (items: KeyRankItem[]) => Promise<Map<string, number>> {
  return async (items) => {
    const out = new Map<string, number>();
    const values = items.map((i) => i.value);
    const paths = [...new Set(items.flatMap((i) => i.otherSide.slice(0, _OTHER_SIDE_SAMPLE).map(_pathText)))];
    const passages = [...new Set(items.map((i) => i.passage).filter((p): p is string => !!p))];
    const vScore = await embedScoreStrings(intent, values);     // 1. the key name
    const pScore = await embedScoreStrings(intent, paths);      // 2. where it leads (other-side files)
    const sScore = passages.length ? await embedScoreStrings(intent, passages) : new Map<string, number>();   // 3. the local use context
    if (!vScore.size && !pScore.size && !sScore.size) return out;   // embeddings absent → caller falls back to fanout
    for (const it of items) {
      const others = it.otherSide.slice(0, _OTHER_SIDE_SAMPLE).map((f) => pScore.get(_pathText(f)) ?? 0);
      const passage = it.passage ? (sScore.get(it.passage) ?? 0) : 0;
      out.set(it.value, Math.max(vScore.get(it.value) ?? 0, passage, ...others, 0));   // relevant if ANY signal says so
    }
    return out;
  };
}
