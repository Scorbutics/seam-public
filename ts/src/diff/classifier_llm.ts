// Port of the LLM passes from src/diff/classifier.py. Prompt templates are copied VERBATIM —
// byte-parity with Python is gated by test/classifier_llm.test.ts (prompts) + inject-llm parity
// (parse/merge). Phase 2: Pass A (cluster). Later phases add seam/role (Pass B) + wiring (Pass C).
import { resolve_backend, runPassRaw, runPassRawAsync, registerPass } from "../core/llm.js";
import { mkSpan, type Hunk, type Span } from "./parser.js";
import { candidate_wirings } from "./symbol_edges.js";

// The diff classifier's LLM passes. All cheap (haiku): they're fact-primed, thinking-light/off
// classifications, not the semantic judgements that justify the strong tier. Registered here so the
// whole LLM surface is enumerable from one source; role votes reuse PASS_ROLE.tag (role.vN variants
// are cheap too and need no separate entry).
const PASS_CLUSTER = registerPass({ tag: "cluster", tier: "cheap", note: "group hunks into intent clusters (Pass A)" });
const PASS_LABEL_CLUSTERS = registerPass({ tag: "label-clusters", tier: "cheap", note: "name each cluster's intent" });
const PASS_ROLE = registerPass({ tag: "role", tier: "cheap", note: "core/link/env/test/noise role per hunk (Pass B)" });
const PASS_WIRE = registerPass({ tag: "wire", tier: "cheap", note: "wire links to the cores they connect (Pass C)" });
const PASS_RECONCILE = registerPass({ tag: "reconcile", tier: "cheap", note: "reconcile wiring across seams" });
const PASS_RECONCILE_ROLES = registerPass({ tag: "reconcile-roles", tier: "cheap", note: "second-pass role reconciliation" });

const ROLES = new Set(["core", "link", "environment", "test", "noise"]);
export const ROLE_VOTES = 3;

// most-common with Python Counter tie-break (first-encountered wins).
function mostCommon(arr: string[]): string {
  const counts = new Map<string, number>();
  for (const x of arr) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = "", bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; best = k; }
  return best;
}

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

// #5 — a structural PRIOR (per-hunk: how the changed symbol sits in the WIDER codebase) injected by the
// composition root (cli/structural_context.ts). Plain data → diff/ stays codebase-ignorant. Only ADDED when a
// context map is supplied, so a no-context run is byte-identical to before (oracle/harness-safe).
const _STRUCTURAL_INSTR = `Some hunks carry a \`structure:\` note — how the changed symbol sits in the WIDER codebase (e.g. "consumed by 40 site(s) — HUB"). Use it to make the product-intent label ACCURATE and STAKES-AWARE (a change to a load-bearing hub reads differently than a leaf tweak); it does NOT change the grouping rules above.`;

export function build_cluster_prompt(hunks: Hunk[], structuralContext?: Map<string, string>): string {
  const hasCtx = !!structuralContext && structuralContext.size > 0;
  const parts = [hasCtx ? _PROMPT_CLUSTER.replace("=== HUNKS ===", `${_STRUCTURAL_INSTR}\n\n=== HUNKS ===`) : _PROMPT_CLUSTER];
  for (const h of hunks) {
    const note = structuralContext?.get(h.id);
    parts.push(`\n--- HUNK ${h.id} | file: ${h.file_path} | change: ${h.change_type}${note ? ` | structure: ${note}` : ""} ---\n`
      + `${h.text.replace(/\s+$/, "")}\n`);
  }
  parts.push("\n=== END HUNKS ===\nReturn the JSON array now.");
  return parts.join("");
}

// ============================ PASS B (seam + role + spans, self-consistency voting) ============
// _PROMPT_SEAM_ROLE — VERBATIM from classifier.py (the `"""\` means no leading newline).
const _PROMPT_SEAM_ROLE = `You are a STRUCTURING tool for code review. You DECOMPOSE a diff. You do NOT
review, judge, score, or comment on quality.

Using the whole diff as context, SEAM and ROLE each hunk. You do NOT group hunks
into intents — intent CLUSTERS are decided in a separate pass; here you only get
the seams and roles right.

1) SEAM the hunks into core↔link wirings. A seam is ONE core (the new/changed
   thing) together with the link(s) that wire THAT core into the system. Cores are
   ANCHORS; links POINT AT the cores they wire — BY HUNK ID. MANY-TO-MANY:
   - A CORE hunk anchors its own seam. Give it a short \`seam_label\` (<= 6 words)
     naming it. The core is identified by ITS OWN hunk id — do NOT invent seam ids.
     Put \`seam_label\` ONLY on cores; a core does not list \`wires\`.
   - Every LINK (and environment) hunk lists \`wires\`: the HUNK IDS of the CORE(S)
     it wires (e.g. "wires":["h5","h12"]). List EVERY core it touches — its FULL
     FOOTPRINT: a hunk supporting several cores names ALL of them. A truly dangling
     link has "wires":[]. Reference cores by their GIVEN hunk id; never invent ids,
     and only wire ids that are actually \`core\` hunks.

   GROUNDING — wiring is TRACING (which symbol defined here is referenced there),
   not guessing. Each hunk may carry a \`candidates:\` line listing other hunk ids it
   mechanically SHARES A NEW SYMBOL with (one defines it, the other references it),
   e.g. "candidates: h5 (BoosterRepository)". These are HIGH-PRECISION real
   references — use them as your FLOOR: when a link references a CORE's new symbol,
   that candidate IS a wiring (wire it). Two judgements remain YOURS:
   (a) PRUNE ambient candidates — a shared util/import used everywhere is NOT
       intent; that hunk is \`environment\` and may wire nothing. Keep only
       candidates that carry the change's INTENT.
   (b) ADD informal wirings the scan can't see — couplings by convention, not by a
       shared symbol. Candidates are a FLOOR, never a ceiling.
   Candidates pointing at non-core hunks just tell you those hunks relate; resolve
   the actual \`wires\` to the CORE(s) in that neighbourhood.

2) ROLE each hunk. \`core\` is the SCARCE, expensive role — DEFAULT to link or
   environment and promote to core only when the hunk clears the bar below. A
   typical change has only 1–3 cores (the genuinely new logic the change is ABOUT)
   surrounded by MANY links/environment. If you find yourself marking most hunks
   core, you are wrong — re-read.

   - core: contains the new DECISION / ALGORITHM / behavioral logic that IS the
     point of the change. Test: "if this hunk were subtly wrong, would the
     FEATURE itself be wrong (not just disconnected)?" Only then is it core.
     SIZE AND SHAPE DO NOT DECIDE ROLE: a one-line guard, a predicate, or a
     helper-shaped function that encodes a new DECISION — computing WHEN, WHETHER,
     or WHICH something happens (a rule/policy) — is CORE, even if tiny or
     utility-looking. A new rule is core no matter how few lines it takes. A
     constant or config value that DECIDES behavior (a threshold, limit, or policy
     that changes what the code does) is also core, not passive data.
   - link: exists to CONNECT the new thing to existing code — call sites, params
     threaded across layers, signature/interface matches, AND adapter/repository
     implementations that merely fulfill a contract (a DB query or in-memory store
     that backs an interface is a LINK, not core — it APPLIES a rule defined
     elsewhere). An adapter is core ONLY IF its query is the SOLE place a business
     rule lives — the decision of which/when is expressed nowhere else. Registering
     a new object into a parent is a link. A guard that merely ROUTES/DISPATCHES by type to wire a new thing
     in is routing → link; but a guard that DECIDES a behavioral outcome is a
     rule → core. The line is "decides an outcome" (core) vs "connects" (link).
     A guard that ENFORCES A POLICY — excludes, filters, or decides eligibility
     for a behavioral reason ("skip X", "only when Y") — is a rule → CORE, even
     though it is shaped like a guard. Do not let the guard SHAPE pull it to link.
   - test: code that VERIFIES the change (unit/integration tests, assertions,
     fixtures, mocks for tests). A test COVERS the core(s) it exercises — it is
     NOT the change and NOT a link. Put the HUNK ID(s) of the core(s) it covers in
     \`wires\` (this is COVERAGE, not wiring). A test is \`test\` regardless of how
     much logic it contains.
   - environment: ambient SUPPORT, not logic — new type/interface/field
     declarations, default-initializing a new field, imports/includes, globals,
     PASSIVE config/data values (inputs CONSUMED by logic defined elsewhere),
     shared utilities. It introduces NO new decision — only scaffolding or ripple.
   - noise: formatting/indentation that slipped through — no logical effect.

   Common mistakes to AVOID (these are NOT core): declaring a type/field/interface
   (environment); importing the new module (environment); implementing a
   repository/adapter that backs a contract (link); threading a parameter or
   editing a call site (link); a constructor initializing a new field
   (environment). Reserve core for the few hunks carrying the actual new logic.

3) SPANS — when ONE hunk genuinely carries MORE THAN ONE role, split it INSIDE
   the hunk instead of forcing a single label. The hunk's BODY lines are
   gutter-numbered (e.g. "  3| +foo"); a span names a CONTIGUOUS line range in
   that numbering. STRONG BIAS: do NOT split. Only emit spans when the roles
   genuinely DIFFER — never to chop one role into pieces. AT MOST ONE \`core\` span
   per hunk; do not invent extra cores just to split. A hunk that is one role
   end-to-end has NO spans (use the flat role).
   IMPORTANT: do NOT let leading import/include/require lines decide a hunk's
   role. When a hunk starts with imports but then adds new LOGIC, the imports are
   environment and the LOGIC keeps its own role — emit spans (imports = environment,
   the logic = its real role, often core). Never label the whole hunk environment
   or link just because it opens with imports.

Return ONLY a JSON array, no prose, no markdown fences. One object per hunk. Do
NOT emit group/intent — those are derived from your wiring.
A MONO-ROLE hunk: a core names itself (seam_label, no wires); a link/environment
lists the core HUNK IDS it wires:
[{"id":"h1","role":"core","seam_label":"currency gateway","rationale":"<=12 words"},
 {"id":"h2","role":"link","wires":["h1"],"rationale":"<=12 words"}]
A FUSED hunk: omit the top-level role and give \`spans\` (line ranges over the
gutter numbering); a core span names itself by the hunk's own id:
[{"id":"h3","spans":[
    {"role":"environment","lines":"1-4","rationale":"new imports for gateway"},
    {"role":"core","lines":"5-19","seam_label":"currency gateway","rationale":"new conversion logic"}]}]
Wire links to cores BY HUNK ID (a link wiring the core in h3 lists "wires":["h3"]).
The rationale is a STRUCTURING note, never a quality judgement.

=== HUNKS ===
`;

function _number_body(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (!lines.length) return "";
  const out = [lines[0]];                          // the @@ header — not numbered
  for (let i = 1; i < lines.length; i++) out.push(`${String(i).padStart(4)}| ${lines[i]}`);
  return out.join("\n");
}

function _fmt_candidates(cands: [string, string][]): string {
  const byOther = new Map<string, string[]>();
  for (const [other, sym] of cands) {
    if (!byOther.has(other)) byOther.set(other, []);
    if (!byOther.get(other)!.includes(sym)) byOther.get(other)!.push(sym);
  }
  if (!byOther.size) return "";
  const parts = [...byOther.entries()].map(([o, syms]) => `${o} (${syms.join(", ")})`);
  return "candidates: " + parts.join("; ");
}

export function build_role_prompt(hunks: Hunk[]): string {
  const cands = candidate_wirings(hunks);
  const parts = [_PROMPT_SEAM_ROLE];
  for (const h of hunks) {
    const candLine = _fmt_candidates(cands.get(h.id) ?? []);
    parts.push(`\n--- HUNK ${h.id} | file: ${h.file_path} | change: ${h.change_type} ---\n`
      + `${_number_body(h.text)}\n` + (candLine ? `${candLine}\n` : ""));
  }
  parts.push("\n=== END HUNKS ===\nReturn the JSON array now.");
  return parts.join("");
}

function _parse_spans(item: any): Span[] {
  const raw = item?.spans;
  if (!Array.isArray(raw)) return [];
  const out: Span[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const role = String(s.role ?? "").trim().toLowerCase();
    if (!ROLES.has(role)) continue;
    const w = s.wires;
    const wires = Array.isArray(w) ? w.map((x: any) => String(x).trim()).filter((x: string) => x) : [];
    out.push(mkSpan({ role, lines: String(s.lines ?? "").trim(), rationale: String(s.rationale ?? "").trim(),
      seam: String(s.seam ?? "").trim(), seam_label: String(s.seam_label ?? "").trim(), wires }));
  }
  return out;
}

function _sync_flat_from_spans(h: Hunk, seamLabel: Map<string, string>): void {
  const core = h.spans.find((s) => s.role === "core") ?? null;
  const primary = core ?? h.spans[0];
  h.role = primary.role;
  h.seam = core ? h.id : "";
  h.seam_label = core ? (primary.seam_label || (seamLabel.get(h.id) ?? "")) : "";
  const wires: string[] = [];
  for (const s of h.spans) for (const x of s.wires) if (x && !wires.includes(x)) wires.push(x);
  h.wires = wires;
  h.rationale = h.spans.filter((s) => s.rationale).map((s) => `${s.role}: ${s.rationale}`).join(" | ");
}

function _eff_role_from_item(item: any): string {
  const spans = _parse_spans(item);
  if (spans.length >= 2) {
    const core = spans.find((s) => s.role === "core") ?? null;
    return (core ?? spans[0]).role;
  }
  const role = String(item?.role ?? "").trim().toLowerCase();
  return ROLES.has(role) ? role : "core";
}

export function aggregate_role_votes(runs: Map<string, any>[], hunkIds: string[]): [Map<string, any>, Map<string, number>] {
  if (!runs.length) return [new Map(), new Map(hunkIds.map((h) => [h, 1.0]))];
  if (runs.length === 1) return [runs[0], new Map(hunkIds.map((h) => [h, 1.0]))];
  const modal = new Map<string, string>();
  for (const hid of hunkIds) modal.set(hid, mostCommon(runs.map((r) => _eff_role_from_item(r.get(hid) ?? {}))));
  const agreement = (r: Map<string, any>) => hunkIds.filter((hid) => _eff_role_from_item(r.get(hid) ?? {}) === modal.get(hid)).length;
  let medoid = runs[0], bestA = agreement(runs[0]);
  for (const r of runs.slice(1)) { const a = agreement(r); if (a > bestA) { bestA = a; medoid = r; } }
  const confidence = new Map<string, number>();
  for (const hid of hunkIds) {
    const shown = _eff_role_from_item(medoid.get(hid) ?? {});
    const roles = runs.map((r) => _eff_role_from_item(r.get(hid) ?? {}));
    confidence.set(hid, roles.filter((x) => x === shown).length / runs.length);
  }
  return [medoid, confidence];
}

// Apply an aggregated role/label result onto the hunks (shared by assign_roles_llm and classify_all).
function applyRoles(hunks: Hunk[], labels: Map<string, any>, roleConf: Map<string, number>): void {
  const seamLabel = new Map<string, string>();
  for (const [hid, item] of labels) {
    const objs = Array.isArray(item?.spans) ? item.spans : null;
    for (const src of objs ?? [item]) {
      if (!src || typeof src !== "object") continue;
      if (String(src.role ?? "").trim().toLowerCase() !== "core") continue;
      const sl = String(src.seam_label ?? "").trim();
      if (sl && !seamLabel.has(hid)) seamLabel.set(hid, sl);
    }
  }
  for (const h of hunks) {
    h.role_confidence = roleConf.get(h.id) ?? 1.0;
    let item = labels.get(h.id) ?? {};
    const spans = _parse_spans(item);
    if (spans.length >= 2) { h.spans = spans; _sync_flat_from_spans(h, seamLabel); continue; }
    if (spans.length === 1 && !ROLES.has(String(item.role ?? "").trim().toLowerCase())) {
      const s = spans[0];
      item = { ...item, role: s.role, seam: s.seam, seam_label: s.seam_label, wires: s.wires, rationale: s.rationale };
    }
    const role = String(item.role ?? "").trim().toLowerCase();
    if (ROLES.has(role)) {
      h.role = role;
      h.rationale = String(item.rationale ?? "").trim();
      if (role === "core") {
        h.seam = h.id;
        h.seam_label = String(item.seam_label ?? "").trim() || (seamLabel.get(h.id) ?? "");
        h.wires = [];
      } else {
        const raw = item.wires;
        h.wires = Array.isArray(raw) ? raw.map((x: any) => String(x).trim()).filter((x: string) => x) : [];
        h.seam = ""; h.seam_label = "";
      }
    } else {
      h.role = "core"; h.seam = h.id; h.rationale = "unclassified — defaulted to core for review";
    }
  }
}

// LLM Pass B (role + span) with self-consistency voting. Serial votes (deterministic for the host
// bus; the real backend trades a little wall-clock vs Python's threads — see PORT-STATUS).
export function assign_roles(hunks: Hunk[], opts: { model?: string; claudeBin?: string | null; roleVotes?: number } = {}): void {
  if (!hunks.length) return;
  const [kind, binary] = resolve_backend(opts.claudeBin);
  const prompt = build_role_prompt(hunks);
  const nVotes = Math.max(1, opts.roleVotes ?? ROLE_VOTES);
  const hunkIds = hunks.map((h) => h.id);
  const roleRuns: Map<string, any>[] = [];
  for (let i = 0; i < nVotes; i++)
    roleRuns.push(runPassRaw(kind, binary, prompt, opts.model ?? "claude-haiku-4-5", ROLE_THINKING,
      nVotes <= 1 ? PASS_ROLE.tag : `role.v${i + 1}`));
  const [labels, roleConf] = aggregate_role_votes(roleRuns, hunkIds);
  applyRoles(hunks, labels, roleConf);
}

// ============================ PASS C (dedicated core-first wiring) ==============================
const _PROMPT_WIRE = `You are WIRING a decomposed change. The roles are ALREADY decided — do NOT change
them. Your ONLY job: for each NON-CORE hunk, list the CORE hunk id(s) it wires —
its FULL FOOTPRINT (every core it connects to, supports, or tests).

Wiring is TRACING, not guessing. Each non-core hunk lists symbol-grounded CANDIDATE
cores (high precision: it shares a NEW symbol with that core). Use them as your
FLOOR:
  - CONFIRM candidates that carry the change's intent (wire them).
  - PRUNE ambient candidates (a shared util used everywhere is NOT a wiring) — that
    hunk may wire NOTHING.
  - ADD core wirings you infer from the rationales (informal couplings the symbol
    scan can't see).
A hunk wires within its OWN cluster unless it genuinely bridges intents. A purely
ambient hunk (supports the whole change, not any one core) has "wires":[].

The CORES and rationales below are a COMPLETE summary of an already-finished role
pass — you do NOT need the source diff, and you must NOT ask for it. Always return
the JSON array, even if a hunk's footprint is uncertain (use [] when unsure).

Return ONLY a JSON array, no prose, one object per NON-CORE hunk, wiring by CORE
hunk id only:
[{"id":"h1","wires":["h10","h14"]},{"id":"h8","wires":["h7"]},{"id":"h2","wires":[]}]

`;

export function build_wire_prompt(hunks: Hunk[]): string {
  const cands = candidate_wirings(hunks);
  const coreIds = new Set(hunks.filter((h) => h.role === "core").map((h) => h.id));
  const parts = [_PROMPT_WIRE, "=== CORES (each anchors a seam) ===\n"];
  for (const h of hunks) if (h.role === "core")
    parts.push(`  ${h.id} [${h.seam_label || "—"}] (cluster ${h.group || "?"}): ${h.rationale || ""}\n`);
  parts.push("\n=== NON-CORE hunks to wire ===\n");
  for (const h of hunks) {
    if (h.role === "core") continue;
    const cc = [...new Set((cands.get(h.id) ?? []).map(([o]) => o).filter((o) => coreIds.has(o)))];
    const cand = cc.length ? cc.join(", ") : "(none — infer from rationale)";
    parts.push(`  ${h.id} ${h.role} (cluster ${h.group || "?"}): ${h.rationale || ""}\n    candidate cores: ${cand}\n`);
  }
  parts.push("\nReturn the JSON array now (one object per NON-CORE hunk).");
  return parts.join("");
}

function run_wire_pass(hunks: Hunk[], kind: string, binary: string, model: string): void {
  const labels = runPassRaw(kind, binary, build_wire_prompt(hunks), model, 0, PASS_WIRE.tag);
  const coreIds = new Set(hunks.filter((h) => h.role === "core").map((h) => h.id));
  for (const h of hunks) {
    if (h.role === "core") { h.wires = []; continue; }
    const raw = (labels.get(h.id) ?? {}).wires;
    const w = Array.isArray(raw) ? raw.map((x: any) => String(x).trim()).filter((x: string) => x) : [];
    h.wires = w.filter((x: string) => coreIds.has(x));
  }
}

export function assign_wiring(hunks: Hunk[], opts: { model?: string; claudeBin?: string | null } = {}): void {
  if (!hunks.length) return;
  const [kind, binary] = resolve_backend(opts.claudeBin);
  run_wire_pass(hunks, kind, binary, opts.model ?? "claude-haiku-4-5");
}

export function merge_wiring_only_clusters(hunks: Hunk[]): void {
  const seamGroup = new Map<string, string>();
  const groupsWithCore = new Set<string>();
  const allGroups = new Set<string>();
  for (const h of hunks) {
    const g = h.group || "";
    allGroups.add(g);
    if (h.role === "core" && h.seam) { seamGroup.set(h.seam, g); groupsWithCore.add(g); }
  }
  const groupIntent = new Map<string, string>();
  for (const h of hunks) if (h.intent) groupIntent.set(h.group || "", h.intent);
  for (const g of allGroups) {
    if (groupsWithCore.has(g)) continue;
    const members = hunks.filter((h) => (h.group || "") === g);
    const targets = new Set<string>();
    for (const h of members) if (h.role === "link")
      for (const w of h.wires) { const tg = seamGroup.get(w); if (tg && tg !== g) targets.add(tg); }
    if (targets.size !== 1) continue;
    const dest = [...targets][0];
    if (!dest) continue;
    for (const h of members) { h.group = dest; h.intent = groupIntent.get(dest) ?? h.intent; }
  }
}

export function reconcile_wires(hunks: Hunk[]): void {
  const clusterSeams = new Map<string, string[]>();
  const allSeams = new Set<string>();
  for (const h of hunks) if (h.role === "core" && h.seam) {
    allSeams.add(h.seam);
    if (!clusterSeams.has(h.group)) clusterSeams.set(h.group, []);
    const lst = clusterSeams.get(h.group)!;
    if (!lst.includes(h.seam)) lst.push(h.seam);
  }
  for (const h of hunks) {
    if (h.role !== "link" && h.role !== "environment") continue;
    const resolved = h.wires.filter((w) => allSeams.has(w));
    const present = clusterSeams.get(h.group) ?? [];
    if (present.length) {
      const inCluster = resolved.filter((w) => present.includes(w));
      h.wires = inCluster.length ? inCluster : [present[0]];
    } else h.wires = resolved;
  }
}

// ============================ hybrid LLM helpers (roles + cluster labels) =======================
export function reconcile_roles_llm(work: Hunk[], opts: { confThreshold?: number; model?: string; claudeBin?: string | null } = {}): void {
  const conf = opts.confThreshold ?? 0.6;
  const targets = work.filter((h) => (h.role_confidence ?? 1.0) < conf);
  if (!targets.length) return;
  const [kind, binary] = resolve_backend(opts.claudeBin);
  const blocks = targets.map((h) => `EDIT ${h.id} [${h.file_path}] deterministic_guess=${h.role}\n${_reconcile_snippet(h)}`).join("\n---\n");
  const prompt = "These diff hunks were role-classified with LOW confidence. For each, pick the one "
    + "best role:\n  core = the new decision/logic/rule the change is ABOUT (verify by reading it);\n"
    + "  link = wires/connects the new thing in (call sites, params, adapters) — routes, doesn't decide;\n"
    + "  environment = ambient support touched in passing (types, imports, config, data);\n"
    + "  test = verifies the change;  noise = formatting/rename, no logical effect.\n\n"
    + `${blocks}\n\n` + 'Output ONLY a JSON array: [{"id":"h12","role":"link"}, ...]';
  const labels = runPassRaw(kind, binary, prompt, opts.model ?? "claude-haiku-4-5", 0, PASS_RECONCILE_ROLES.tag);
  for (const h of targets) {
    const r = String((labels.get(h.id) ?? {}).role ?? "").trim().toLowerCase();
    if (ROLES.has(r) && r !== h.role) h.role = r;
  }
}

export function label_clusters_llm(work: Hunk[], opts: { model?: string; claudeBin?: string | null } = {}): void {
  const groups = new Map<string, Hunk[]>();
  for (const h of work) if (h.group) { if (!groups.has(h.group)) groups.set(h.group, []); groups.get(h.group)!.push(h); }
  if (!groups.size) return;
  const [kind, binary] = resolve_backend(opts.claudeBin);
  const blocks: string[] = [];
  for (const [g, hs] of groups) {
    const sig = [...new Set(hs.map((h) => h.seam_label || baseName(h.file_path)))].sort().join(", ").slice(0, 300);
    blocks.push(`GROUP ${g}: ${sig}`);
  }
  const prompt = "Each GROUP is a set of related diff hunks (shown by their key symbols/files). Give "
    + 'each a SHORT product-intent label — what the user-facing change is, e.g. '
    + '"add currency to checkout", "migrate webhooks to v2". Keep it under ~6 words.\n\n'
    + blocks.join("\n") + '\n\nOutput ONLY a JSON array: [{"id":"g1","intent":"…"}, ...]';
  const labels = runPassRaw(kind, binary, prompt, opts.model ?? "claude-haiku-4-5", CLUSTER_THINKING, PASS_LABEL_CLUSTERS.tag);
  for (const h of work) {
    const it = String((labels.get(h.group) ?? {}).intent ?? "").trim();
    if (it) h.intent = it;
  }
}

// ============================ all-LLM classify (cluster + role-voting + wire) ===================
// Port of classifier.classify (default WIRE_PASS on). Serial passes (deterministic for the bus).
export function classify_all_llm(hunks: Hunk[], opts: { model?: string; claudeBin?: string | null; roleVotes?: number } = {}): void {
  if (!hunks.length) return;
  const [kind, binary] = resolve_backend(opts.claudeBin);
  const model = opts.model ?? "claude-haiku-4-5";
  const nVotes = Math.max(1, opts.roleVotes ?? ROLE_VOTES);
  const hunkIds = hunks.map((h) => h.id);

  const clusterLabels = runPassRaw(kind, binary, build_cluster_prompt(hunks), model, CLUSTER_THINKING, PASS_CLUSTER.tag);
  const rolePrompt = build_role_prompt(hunks);
  const roleRuns: Map<string, any>[] = [];
  for (let i = 0; i < nVotes; i++)
    roleRuns.push(runPassRaw(kind, binary, rolePrompt, model, ROLE_THINKING, nVotes <= 1 ? "role" : `role.v${i + 1}`));

  const groupIntent = new Map<string, string>();
  const groups = new Map<string, [string, string]>();
  for (const [hid, item] of clusterLabels) {
    const g = String(item.group ?? "").trim();
    const it = String(item.intent ?? "").trim();
    groups.set(hid, [g, it]);
    if (g && it && !groupIntent.has(g)) groupIntent.set(g, it);
  }
  const [labels, roleConf] = aggregate_role_votes(roleRuns, hunkIds);
  for (const h of hunks) {
    const [g, it] = groups.get(h.id) ?? ["", ""];
    h.group = g;
    h.intent = it || (groupIntent.get(g) ?? "");
  }
  applyRoles(hunks, labels, roleConf);
  run_wire_pass(hunks, kind, binary, model);
  merge_wiring_only_clusters(hunks);
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

export async function reconcile_llm(cores: Map<string, Hunk>, targets: Hunk[], hints: Map<string, string[]>,
                             opts: { model?: string; claudeBin?: string | null } = {}): Promise<ReconcileResult> {
  if (!cores.size) return { labels: new Map(), groups: new Map(), drawn: new Map() };
  const [kind, binary] = resolve_backend(opts.claudeBin);
  const prompt = build_reconcile_prompt(cores, targets, hints);
  const out = await runPassRawAsync(kind, binary, prompt, opts.model ?? "claude-haiku-4-5", 0, PASS_RECONCILE.tag);
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
export async function assign_clusters(hunks: Hunk[], opts: { model?: string; claudeBin?: string | null; structuralContext?: Map<string, string> } = {}): Promise<void> {
  if (!hunks.length) return;
  const [kind, binary] = resolve_backend(opts.claudeBin);
  const labels = await runPassRawAsync(kind, binary, build_cluster_prompt(hunks, opts.structuralContext), opts.model ?? "claude-haiku-4-5",
    CLUSTER_THINKING, PASS_CLUSTER.tag);
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
