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

// --- hybrid wiring: the inverted reconcile (LLM groups cores into seams + draws each edit's line) ---
const _RECONCILE_SNIPPET_LINES = 24;
const _CORE_SNIPPET_LINES = 14;
const baseName = (p: string) => p.split("/").pop() ?? p;

function _reconcile_snippet(h: Hunk): string {
  return h.text.split("\n").slice(1).slice(0, _RECONCILE_SNIPPET_LINES).join("\n");
}
function _core_snippet(h: Hunk): string {
  return h.text.split("\n").slice(1).slice(0, _CORE_SNIPPET_LINES).join("\n");
}

export function build_reconcile_prompt(cores: Map<string, Hunk>, targets: Hunk[], hints: Map<string, string[]>): string {
  const coreBlocks = [...cores.entries()]
    .map(([cid, h]) => `CORE ${cid}  [${baseName(h.file_path)}]\n${_core_snippet(h)}`).join("\n---\n");
  const editBlock = (h: Hunk): string => {
    const hint = (hints.get(h.id) ?? []).filter((c) => cores.has(c))
      .map((c) => `${c}="${cores.get(c)!.seam_label || c}"`).join(", ") || "(none found)";
    return `EDIT ${h.id}  [${baseName(h.file_path)}]  role=${h.role}\n${_reconcile_snippet(h)}\n  symbols suggest: ${hint}`;
  };
  const editBlocks = targets.map(editBlock).join("\n---\n");
  const task2 = targets.length
    ? "TASK 2 — for each EDIT, draw its true dependency line: which CORES does it ACTUALLY "
      + "depend on — calls, modifies, is configured/typed by, or routes to — BY MEANING? The "
      + "'symbols suggest' line is a HINT from a crude symbol scan, NOT the answer: confirm the "
      + "ones that are real couplings, DROP any it merely co-renders/co-imports a shared "
      + "component with, and ADD any real coupling the scan missed. One, several, or NONE; "
      + "choose only from the CORE ids.\n\n"
    : "";
  return (
    "A diff is decomposed into CORES (units of new logic) and EDITS that wire into them.\n\n"
    + "TASK 1 — group the CORES into SEAMS by TECHNICAL INTENT. A seam is ONE technical "
    + "intent and may hold SEVERAL cores: cores that are the same logical change/feature "
    + "(several hunks of one component, or a component + its skeleton/header) share one "
    + '`seam` key. Give each core that seam key plus a short seam `label` (3-6 words: what '
    + 'the seam DOES, e.g. "webhook form", "loading skeletons") — NOT a symbol name. Distinct '
    + "intents get distinct seam keys; don't over-merge unrelated cores.\n\n"
    + task2
    + `CORES:\n${coreBlocks}\n\n`
    + (targets.length ? `EDITS:\n${editBlocks}\n\n` : "")
    + 'Output ONLY a JSON array. Per CORE: {"id":"h8","seam":"S1","label":"…"}.'
    + (targets.length ? ' Per EDIT: {"id":"h6","wires":["h8", …]}.' : "")
  );
}

export interface ReconcileResult { labels: Map<string, string>; groups: Map<string, string>; drawn: Map<string, string[]>; }

export function reconcile_llm(cores: Map<string, Hunk>, targets: Hunk[], hints: Map<string, string[]>,
                             opts: { model?: string; claudeBin?: string | null } = {}): ReconcileResult {
  if (!cores.size) return { labels: new Map(), groups: new Map(), drawn: new Map() };
  const [kind, binary] = resolve_backend(opts.claudeBin);
  const prompt = build_reconcile_prompt(cores, targets, hints);
  const out = runPassRaw(kind, binary, prompt, opts.model ?? "claude-haiku-4-5", 0, "reconcile");
  const labels = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const [cid, o] of out) {
    if (!cores.has(cid)) continue;
    const lab = String(o.label ?? "").trim();
    if (lab) labels.set(cid, lab);
    const seam = String(o.seam ?? "").trim();
    if (seam) groups.set(cid, seam);
  }
  const drawn = new Map<string, string[]>();
  for (const h of targets) {
    const o = out.get(h.id);
    if (o && Array.isArray(o.wires)) drawn.set(h.id, o.wires.filter((c: string) => cores.has(c)));
  }
  return { labels, groups, drawn };
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
