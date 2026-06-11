// Port of the LLM passes from src/diff/classifier.py. Prompt templates are copied VERBATIM —
// byte-parity with Python is gated by test/classifier_llm.test.ts (prompts) + inject-llm parity
// (parse/merge). Phase 2: Pass A (cluster). Later phases add seam/role (Pass B) + wiring (Pass C).
import { resolve_backend, runPassRaw } from "../core/llm.js";
import type { Hunk } from "./parser.js";

export const CLUSTER_THINKING: number | null = 2048;
export const ROLE_THINKING: number | null = 0;
const _CHARS_PER_TOKEN = 3.5;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
const _SYSTEM_OVERHEAD_TOKENS = 25_000;
const _OUTPUT_TOKENS_PER_HUNK = 60;

export function estimate_tokens(text: string): number {
  return Math.floor(text.length / _CHARS_PER_TOKEN) + 1;
}
export function fits_context(prompt: string, nHunks: number, contextWindow = DEFAULT_CONTEXT_WINDOW): [boolean, number, number] {
  const estIn = estimate_tokens(prompt);
  const estOut = nHunks * _OUTPUT_TOKENS_PER_HUNK;
  const usable = contextWindow - _SYSTEM_OVERHEAD_TOKENS;
  return [estIn + estOut <= usable, estIn, usable];
}

// VERBATIM from classifier.py _PROMPT_CLUSTER (the leading `"""\` means no leading newline).
const _PROMPT_CLUSTER = `You are a STRUCTURING tool for code review. You DECOMPOSE a diff. You do NOT
review, judge, score, or comment on quality.

Your ONLY job in this pass: GROUP the hunks into FUNCTIONAL CLUSTERS — each one a
distinct PRODUCT INTENT (the "what are we building" of a coherent sub-change),
using the whole diff as context. A diff often bundles several distinct product
intents; each becomes one cluster. This is the COARSER of two grains of intent:
clusters carry PRODUCT intent here, while the finer TECHNICAL intent of each
individual seam (e.g. "introduce strategy pattern") is named in a separate pass —
do NOT reach for that finer grain here. Grouping is GRAMMAR-driven (what wires to
what), NOT topic similarity: put a link in the SAME cluster as the core it wires
in — the joint and the thing it joins belong together. Give each cluster a stable
id ("g1", "g2", ...) and a short product-intent label (<= 8 words). One product
intent = one cluster, even if it spans several files.

PREFER THE FEWEST CLUSTERS that still separate genuinely independent intents. Be
COARSE, not fine:
- Introducing one new thing and migrating several call-sites to it is ONE intent
  (one core + its links across many files), NOT one cluster per call-site.
- A helper/strategy that exists only to serve a new mechanism belongs in the SAME
  cluster as that mechanism — even if it lives in a different file.
- Split into separate clusters ONLY when two intents could ship in separate PRs
  without depending on each other. If unsure, MERGE.

Return ONLY a JSON array, no prose, no markdown fences. One object per hunk:
[{"id":"h1","group":"g1","intent":"add currency to checkout"},
 {"id":"h2","group":"g1","intent":"add currency to checkout"}]
Every hunk in the same group MUST repeat the same intent string.

=== HUNKS ===
`;

export function build_cluster_prompt(hunks: Hunk[]): string {
  const parts = [_PROMPT_CLUSTER];
  for (const h of hunks) {
    parts.push(`\n--- HUNK ${h.id} | file: ${h.file_path} | change: ${h.change_type} ---\n`
      + `${h.text.replace(/\s+$/, "")}\n`);
  }
  parts.push("\n=== END HUNKS ===\nReturn the JSON array now.");
  return parts.join("");
}

// LLM Pass A (cluster) only: fill group/intent (product intent). Mirrors classifier.assign_clusters.
export function assign_clusters(hunks: Hunk[], opts: { model?: string; claudeBin?: string | null } = {}): void {
  if (!hunks.length) return;
  const [kind, binary] = resolve_backend(opts.claudeBin);
  const labels = runPassRaw(kind, binary, build_cluster_prompt(hunks), opts.model ?? "claude-haiku-4-5",
    CLUSTER_THINKING, "cluster");
  const groupIntent = new Map<string, string>();
  const groups = new Map<string, [string, string]>();
  for (const [hid, item] of labels) {
    const g = String(item.group ?? "").trim();
    const it = String(item.intent ?? "").trim();
    groups.set(hid, [g, it]);
    if (g && it && !groupIntent.has(g)) groupIntent.set(g, it);
  }
  for (const h of hunks) {
    const [g, it] = groups.get(h.id) ?? ["", ""];
    h.group = g;
    h.intent = it || (groupIntent.get(g) ?? "");
  }
}
