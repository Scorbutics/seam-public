// THE DIFF↔CODEBASE BRIDGE — the hero composition (lives at the CLI/composition root because diff/ and
// codebase/ must never import each other; this is the first deliberate cross-mode pass).
//
// After a diff is classified, annotate each CORE seam with what the change touches BEYOND its own lines:
//   external   — the transitive codebase impact (consumers of the changed symbol) in files NOT in the PR
//   crossStack — data-flow readers/writers (a shared DB table / route) in files NOT in the PR: the
//                "you changed the write, not the read" signal no diff-only or codebase-only tool can give
//   fanIn      — the STRUCTURAL WEIGHT: total consumers (in+out of PR) of the seam's hottest core, so the
//                reviewer calibrates scrutiny by stakes (a hub change is riskier than a leaf change)
//   gaps       — opaque callers where the impact view is incomplete (so the annotation is honest, not noisy)
//   flowOrder  — the seams are re-ordered along the CALL FLOW (entry → downstream) so review follows the
//                path the change runs on, not file order (#4 spine-ordering — see orderSeamsByFlow)
// The `!changedFiles.has(...)` filter is the whole value: the signal is what's affected AND untouched.
//
// Discipline (this is what keeps a review annotation trustworthy enough to leave ON): cross-stack is
// INFORMATION, not an assertion ("reads `payments` — verify"), provenance-gated, and gaps are surfaced.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RegexFactsProvider, changed_newside } from "../diff/facts.js";
import type { Hunk } from "../diff/parser.js";
import { normpath } from "../core/resolve/walk.js";
import { run_pass_async, registerPass, available, get_host_bus, ClassifierError as LLMError } from "../core/llm.js";
import { projectImpact } from "../codebase/grow/impact.js";
import { EngineCtx } from "../codebase/engine_ctx.js";
import { scoreRelevanceAst, externalRelevance, type Relevance } from "./review_relevance.js";

const TRIAGE_PASS = registerPass({ tag: "review-triage", tier: "strong", note: "judge if a change is relevant to an unknown consumer — semantic" });

// A seam whose hottest core has ≥ this many consumers is a HUB — worth surfacing for scrutiny even when the
// change looks contained (many things depend on it, so a subtle break is costly). Tuned high enough that a
// run-of-the-mill util doesn't trip it; the JSON carries the exact `fanIn` regardless.
const HUB_FANIN = 8;

export interface ExternalImpact { symbol: string; file: string; hop: number; relevance: Relevance }
export interface CrossStackEdge { symbol: string; file: string; key: string; relation: string; provenance: string; relevance: Relevance }
export interface SeamImpact {
  external: ExternalImpact[];
  crossStack: CrossStackEdge[];
  gaps: { mechanism: string; evidence: string }[];
  truncated?: boolean;
  fanIn?: number;        // STRUCTURAL WEIGHT — total consumers (in+out of PR) of the seam's hottest core
  fanInFiles?: number;   // …across this many files (the blast-radius magnitude for scrutiny calibration)
}

// Per core hunk, the symbols a change to it ripples FROM: newly-defined symbols + the modified enclosing
// symbol (an edit inside `chargeCard` that doesn't redefine it still has `chargeCard` as its subject).
function subjectsOf(facts: { defines: Set<string>; enclosing: Set<string> } | undefined): string[] {
  if (!facts) return [];
  return [...new Set([...facts.defines, ...facts.enclosing])].filter(Boolean);
}

// Annotate the emitted seam model in place. `hunks` are the classified Hunk objects (for role + file +
// facts); `model` is the emit_seams_json output whose seams we enrich. Bounded + SEQUENTIAL on purpose
// (build_footprint shares module-global caches → concurrent collection corrupts results).
export async function annotateReviewImpact(
  model: any, hunks: Hunk[], repo: string,
  opts: { maxSymbols?: number; dataCoupling?: boolean; dataCouplingLlm?: boolean; model?: string; claudeBin?: string | null } = {},
): Promise<void> {
  // With the shared ctx the repo-wide coupling index builds ONCE and each symbol after is ~0.2s, so the
  // budget covers a whole PR rather than the old per-symbol coupling cost. 120 clears virtually every real
  // PR; still bounded so a runaway mega-diff (a 100s-of-file refactor — split it) truncates HONESTLY (the
  // `truncated` flag says "impact ≥ shown") instead of running unbounded.
  const budget = opts.maxSymbols ?? 120;
  const changed = new Set(hunks.map((h) => normpath(h.file_path)));
  const byId = new Map(hunks.map((h) => [h.id, h]));
  // Any changed code hunk can ripple — a one-line edit to a DB write is the headline cross-stack case and
  // is often classified `environment`, not `core`. So scope to all CODE roles (skip test/noise). Order
  // core-first, then by CHANGE SIZE (added-line count) — so when the budget truncates a huge PR, the
  // largest, most impactful changes are analysed first and the dropped tail is the smallest edits.
  const ROLES = new Set(["core", "link", "environment"]);
  const addedCount = (h: Hunk) => changed_newside(h)?.[2].size ?? 0;
  const subjectHunks = hunks.filter((h) => h.role && ROLES.has(h.role))
    .sort((a, b) => Number(b.role === "core") - Number(a.role === "core") || addedCount(b) - addedCount(a));
  if (!subjectHunks.length) return;
  const facts = await new RegexFactsProvider().facts(subjectHunks);

  // analyze = pure edge DISCOVERY (cached per symbol); relevance is applied later, per HUNK (it depends on
  // the change's added lines, which differ by hunk even for the same symbol).
  type RawEdge = { symbol: string; file: string; hop: number; key: string; relation: string; provenance: string };
  // fanIn/fanInFiles = the FULL blast-radius magnitude (in- AND out-of-PR consumers) — the STRUCTURAL WEIGHT
  // of the change, so a reviewer calibrates scrutiny by stakes (a 3-line edit to a 40-consumer hub > a
  // 200-line edit to a leaf). `external` keeps only the out-of-PR slice; the weight keeps the whole.
  // inPr = consumers (callers) of this symbol that ARE in the PR — the within-change call edges, used to
  // order seams by FLOW (entry → downstream) so review follows the call path, not file order.
  type Raw = { external: RawEdge[]; crossStack: RawEdge[]; gaps: { mechanism: string; evidence: string }[]; truncated?: boolean; fanIn: number; fanInFiles: number; inPr: { file: string; symbol: string }[] };
  const cache = new Map<string, Raw>();
  let spent = 0;
  // ONE shared cache context across every symbol's footprints — the data-coupling key index is repo-wide
  // and ~4s to build, so without sharing it would rebuild per symbol (the measured 1m39s on cal.com).
  // Shared, it builds once (~4s) and every later symbol reuses it (~0.2s). Same trick the grow loop uses.
  const ctx = new EngineCtx();

  const analyze = async (file: string, symbol: string): Promise<Raw> => {
    const k = `${normpath(file)}#${symbol}`;
    const hit = cache.get(k); if (hit) return hit;
    const res: Raw = { external: [], crossStack: [], gaps: [], fanIn: 0, fanInFiles: 0, inPr: [] };
    if (spent >= budget) { res.truncated = true; cache.set(k, res); return res; }
    spent++;
    try {
      // Review wants what a change DIRECTLY breaks → depth 1 (the immediate consumers). Depth 2's transitive
      // hop fans out O(impact-tree) consumer resolutions — minutes on a hub symbol in a big repo — for indirect
      // dependents that are noisier and less actionable in review anyway. Depth 1 is also the truer `fanIn`
      // (#3): direct dependents, not an inflated transitive count. ctx amortizes the shared import index.
      const im = await projectImpact(repo, file, symbol, { dataCoupling: false, depth: 1, ctx, skipCallsite: true });
      res.external = im.impacted.filter((m) => !changed.has(normpath(m.file))).map((m) => ({ symbol: m.symbol, file: m.file, hop: m.hop, key: "", relation: "", provenance: "RESOLVED_FULL" }));
      res.fanIn = im.impacted.length;                                       // total blast radius (the structural weight)
      res.fanInFiles = new Set(im.impacted.map((m) => normpath(m.file))).size;
      res.inPr = im.impacted.filter((m) => changed.has(normpath(m.file))).map((m) => ({ file: m.file, symbol: m.symbol }));   // in-PR callers → flow edges
      res.gaps = im.gaps;
      // NB: we deliberately cap impact at depth 2 (direct breakage) for review — so projectImpact's own
      // depth-truncation is BY DESIGN, not flagged. Only the SYMBOL budget (couldn't analyze every changed
      // symbol) is a real incompleteness, set in the `spent >= budget` branch above.
    } catch { /* leave external empty */ }
    try {
      // cross-stack: a data-flow boundary (a shared key) the changed symbol touches, whose other side lives in
      // a file the PR didn't touch. TARGETED (couplingOtherSides): the change's keys are known LOCALLY, so we
      // grep the repo for those exact values and scan only the matching files — O(files that mention the key),
      // NOT a full-repo floor index. An anchor with no key returns instantly (no scan). dataCouplingLlm learns
      // an unknown-framework key once (cached to `.seam/`). Degrades to the floor with no backend.
      const { couplingOtherSides } = await import("../codebase/coupling/index.js");
      for (const side of await couplingOtherSides(repo, file, symbol, { llm: opts.dataCouplingLlm, model: opts.model, claudeBin: opts.claudeBin }, ctx)) {
        if (changed.has(normpath(side.file)) || normpath(side.file) === normpath(file)) continue;   // not in the PR, not the anchor file
        res.crossStack.push({ symbol: side.symbol, file: side.file, key: side.value, relation: side.edgeKind, provenance: side.provenance, hop: 1 });
      }
    } catch { /* leave crossStack empty */ }
    cache.set(k, res);
    return res;
  };

  // a relevance is an UPGRADE-only merge: relevant > unknown > irrelevant (a flag the floor proves relevant
  // for ONE hunk stays relevant even if another hunk's change looks unrelated).
  const RANK: Record<Relevance, number> = { relevant: 2, unknown: 1, irrelevant: 0 };
  const better = (a: Relevance, b: Relevance) => (RANK[a] >= RANK[b] ? a : b);

  // FLOW bookkeeping (#4): map every core SUBJECT → its seam, and collect each seam's in-PR callers, so the
  // seams can be topologically ordered along the call path afterwards (entry → downstream).
  const subjectToSeam = new Map<string, any>();          // "file#symbol" → the seam whose core defines it
  const seamCallerKeys = new Map<any, Set<string>>();    // seam → "file#symbol" of the in-PR cores that CALL it
  const allSeams: any[] = [];

  for (const cluster of model.clusters ?? []) {
    for (const seam of cluster.seams ?? []) {
      allSeams.push(seam);
      const callerKeys = new Set<string>();
      const ext = new Map<string, ExternalImpact>(), cs = new Map<string, CrossStackEdge>();
      const gaps = new Map<string, { mechanism: string; evidence: string }>();
      let truncated = false, maxFan = 0, maxFanFiles = 0;   // the seam's weight = its HOTTEST core's blast radius
      for (const sh of seam.hunks ?? []) {
        const h = byId.get(sh.id);
        if (!h || !h.role || !ROLES.has(h.role)) continue;
        const cn = changed_newside(h);
        const added = [...(cn?.[2].values() ?? [])];              // the change's added line strings
        const changedLines = new Set(cn?.[2].keys() ?? []);       // …and their new-side line numbers (for AST)
        for (const sym of subjectsOf(facts.get(h.id))) {
          subjectToSeam.set(`${normpath(h.file_path)}#${sym}`, seam);   // this seam defines `sym`
          const r = await analyze(h.file_path, sym);
          if (r.truncated) truncated = true;
          if (r.fanIn > maxFan) { maxFan = r.fanIn; maxFanFiles = r.fanInFiles; }   // hottest core wins
          for (const c of r.inPr) callerKeys.add(`${normpath(c.file)}#${c.symbol}`);   // who (in-PR) calls this seam
          for (const x of r.external) {
            const rel = externalRelevance(added, sym), k = `${x.file}#${x.symbol}`;
            const prev = ext.get(k);
            ext.set(k, { symbol: x.symbol, file: x.file, hop: x.hop, relevance: prev ? better(prev.relevance, rel) : rel });
          }
          for (const x of r.crossStack) {
            const rel = await scoreRelevanceAst(repo, h.file_path, changedLines, added, x.file, x.key), k = `${x.file}#${x.symbol}#${x.key}`;
            const prev = cs.get(k);
            cs.set(k, { symbol: x.symbol, file: x.file, key: x.key, relation: x.relation, provenance: x.provenance, relevance: prev ? better(prev.relevance, rel) : rel });
          }
          for (const x of r.gaps) gaps.set(`${x.mechanism}\0${x.evidence}`, x);
        }
      }
      seamCallerKeys.set(seam, callerKeys);
      if (ext.size || cs.size || gaps.size || maxFan > 0) {
        const acc: SeamImpact = {
          external: [...ext.values()].sort((a, b) => a.hop - b.hop || a.file.localeCompare(b.file)),
          crossStack: [...cs.values()], gaps: [...gaps.values()], ...(truncated ? { truncated: true } : {}),
          ...(maxFan > 0 ? { fanIn: maxFan, fanInFiles: maxFanFiles } : {}),
        };
        seam.impact = acc;   // additive contract field — clients that don't know it ignore it
      }
    }
  }

  orderSeamsByFlow(model, allSeams, subjectToSeam, seamCallerKeys);
}

// #4 SPINE-ORDERING — order the seams along the CALL FLOW (entry → downstream) instead of file/hunk order, so
// review follows the path the change actually runs on. The changed cores form a sub-graph: if seam SC's core
// CALLS seam S's core (S's in-PR consumer set contains SC's subject), SC is upstream → read SC first. We
// topologically sort that DAG (Kahn; ties + cycles fall back to the original emit order, stable), stamp each
// seam's `flowOrder`, then reorder the seams within each cluster and the clusters by their entry's order. Only
// runs under the bridge (needs the codebase consumer sets); a change with no internal call edges is untouched.
function orderSeamsByFlow(model: any, allSeams: any[], subjectToSeam: Map<string, any>, seamCallerKeys: Map<any, Set<string>>): void {
  if (allSeams.length < 2) return;
  const idx = new Map(allSeams.map((s, i) => [s, i]));               // original emit order — the stable tiebreak
  const callees = new Map<any, Set<any>>(allSeams.map((s) => [s, new Set<any>()]));   // caller → callees
  const indeg = new Map<any, number>(allSeams.map((s) => [s, 0]));   // # of in-PR callers (upstream seams)
  for (const callee of allSeams) {
    for (const ck of seamCallerKeys.get(callee) ?? []) {
      const caller = subjectToSeam.get(ck);
      if (!caller || caller === callee || callees.get(caller)!.has(callee)) continue;
      callees.get(caller)!.add(callee);
      indeg.set(callee, indeg.get(callee)! + 1);
    }
  }
  const bySrc = (a: any, b: any) => idx.get(a)! - idx.get(b)!;
  const ready = allSeams.filter((s) => indeg.get(s) === 0).sort(bySrc);   // entry points (nothing in-PR calls them)
  const order: any[] = [], seen = new Set<any>();
  while (ready.length) {
    const s = ready.shift()!;
    if (seen.has(s)) continue;
    seen.add(s); order.push(s);
    const freed: any[] = [];
    for (const c of callees.get(s)!) { indeg.set(c, indeg.get(c)! - 1); if (indeg.get(c) === 0) freed.push(c); }
    ready.push(...freed.sort(bySrc));
  }
  for (const s of allSeams) if (!seen.has(s)) order.push(s);   // cycle remainder → original order
  order.forEach((s, i) => { s.flowOrder = i; });               // additive contract field
  // reorder presentation: seams within a cluster by flow, then clusters by their entry seam's order
  const minFlow = (cl: any) => Math.min(...((cl.seams ?? []).map((s: any) => s.flowOrder ?? 0)), Infinity);
  for (const cl of model.clusters ?? []) (cl.seams ?? []).sort((a: any, b: any) => (a.flowOrder ?? 0) - (b.flowOrder ?? 0));
  (model.clusters ?? []).sort((a: any, b: any) => minFlow(a) - minFlow(b));
}

// LAYER 3 — LLM triage on the `unknown` RESIDUAL only (never the easy 80% the floor already decided).
// For each unknown flag, give the model the change's added lines + the consumer's code and ask whether the
// change is relevant; reclassify relevant/irrelevant, leave `unsure` as unknown. Needs an LLM (host bus or
// a binary); a no-op otherwise. Returns how many flags it triaged. Recall-safe: `unsure` stays surfaced.
export async function triageUnknowns(model: any, hunks: Hunk[], repo: string, opts: { model?: string; claudeBin?: string | null } = {}): Promise<number> {
  if (!get_host_bus() && !available(opts.claudeBin)) return 0;
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const items: { id: string; edge: any; change: string; reader: string }[] = [];
  let n = 0;
  for (const cluster of model.clusters ?? []) {
    for (const seam of cluster.seams ?? []) {
      const im: SeamImpact | undefined = seam.impact;
      if (!im) continue;
      const change = (seam.hunks ?? []).flatMap((sh: any) => { const h = byId.get(sh.id); return h ? [...(changed_newside(h)?.[2].values() ?? [])] : []; }).join("\n");
      for (const edge of [...im.crossStack, ...im.external]) {
        if (edge.relevance !== "unknown") continue;
        let reader = ""; try { reader = readFileSync(join(repo, edge.file), "utf-8").slice(0, 1800); } catch { /* keep empty */ }
        items.push({ id: `u${n++}`, edge, change, reader });
      }
    }
  }
  if (!items.length) return 0;
  const lines = [
    "A code change MIGHT affect these consumers. For EACH item, decide if the change is RELEVANT to that",
    "consumer — i.e. the consumer depends on the specific thing that changed. Be conservative: answer",
    '"unsure" rather than guess. Output ONLY a JSON array: [{"id":"<id>","verdict":"relevant|irrelevant|unsure","reason":"<short>"}]',
    "",
  ];
  for (const it of items) lines.push(`### ${it.id}`, "CHANGE (added lines):", it.change, "CONSUMER:", it.reader, "");
  let out: Map<string, any>;
  try { out = await run_pass_async(lines.join("\n"), { model: opts.model, claudeBin: opts.claudeBin, tag: TRIAGE_PASS.tag }); }
  catch (e) { if (e instanceof LLMError) return 0; throw e; }
  for (const it of items) {
    const v = out.get(it.id);
    const verdict = String(v?.verdict ?? "").toLowerCase();
    if (verdict === "relevant" || verdict === "irrelevant") it.edge.relevance = verdict;
    if (v?.reason) it.edge.triageReason = String(v.reason);   // additive — why the LLM decided
  }
  return items.length;
}

// LAYER 2 — the human report, TIERED by the floor's relevance: `relevant` is shown loud; `unknown` is
// collapsed to a count ("verify"); `irrelevant` (provably-unrelated) is dropped from the human view (it
// stays in the JSON, suppressed). This is the anti-fatigue surface — the reader sees only what the floor
// couldn't rule out. Cross-stack leads, framed as INFORMATION to verify, never an asserted bug.
export function renderReviewImpact(model: any): string {
  const out: string[] = ["# Review impact (what this change touches beyond its own lines)", ""];
  let any = false, totalSuppressed = 0;
  for (const cluster of model.clusters ?? []) {
    for (const seam of cluster.seams ?? []) {
      const im: SeamImpact | undefined = seam.impact;
      if (!im) continue;
      const csRel = im.crossStack.filter((c) => c.relevance === "relevant");
      const csUnk = im.crossStack.filter((c) => c.relevance === "unknown");
      const extRel = im.external.filter((e) => e.relevance === "relevant");
      const extUnk = im.external.filter((e) => e.relevance === "unknown");
      const suppressed = im.crossStack.length - csRel.length - csUnk.length + (im.external.length - extRel.length - extUnk.length);
      totalSuppressed += suppressed;
      const fanIn = im.fanIn ?? 0, isHub = fanIn >= HUB_FANIN;
      // show a seam if it has a flag to verify OR it's a structural HUB (many depend on it — review even a
      // contained-looking change). A non-hub, no-flag seam stays out of the human view (its weight is in JSON).
      if (!csRel.length && !csUnk.length && !extRel.length && !extUnk.length && !im.gaps.length && !isHub) continue;
      any = true;
      out.push(`## ${seam.label ?? seam.id ?? "seam"}`);
      // STRUCTURAL WEIGHT first — it calibrates how seriously to take the flags below (a relevant flag on a
      // 40-consumer hub matters more than on a 2-consumer leaf). A hub with no relevant flag is reassuring-
      // but-attentive: "looks contained, but a lot rides on this."
      if (fanIn > 0) {
        const contained = isHub && !csRel.length && !extRel.length;
        out.push(`  ${isHub ? "⚖ high blast radius" : "blast radius"}: ${fanIn} consumer(s) across ${im.fanInFiles ?? 0} file(s)${contained ? " — change looks contained, but many depend on this" : ""}`);
      }
      if (csRel.length) {
        out.push("  ⚠ cross-stack (the change touches a field this reader uses — verify):");
        for (const c of csRel) out.push(`     ${c.relation} of '${c.key}' → ${c.symbol} (${c.file})`);
      }
      if (csUnk.length) {
        out.push(`  cross-stack to verify (${csUnk.length} — couldn't prove relevant or not):`);
        for (const c of csUnk) out.push(`     ${c.relation} of '${c.key}' → ${c.symbol} (${c.file})${c.provenance !== "RESOLVED_FULL" ? `  [${c.provenance}]` : ""}`);
      }
      if (extRel.length) out.push(`  affects (signature change) ${extRel.length} caller(s): ${extRel.slice(0, 6).map((e) => `${e.symbol} (${e.file})`).join(", ")}`);
      if (extUnk.length) out.push(`  + ${extUnk.length} consumer(s) outside this PR to consider`);
      if (im.gaps.length) out.push(`  gaps: ${im.gaps.length} opaque caller(s) — impact may be larger (grep these)`);
      if (im.truncated) out.push("  (truncated — symbol budget hit; impact ≥ shown)");
      out.push("");
    }
  }
  if (!any) out.push("No relevant impact found for the changed code — the change looks self-contained.");
  if (totalSuppressed) out.push(`(${totalSuppressed} flag(s) suppressed as provably-unrelated by the deterministic floor)`);
  out.push("This is the structural blast radius of the change; the review judgement over it is yours.");
  // The .seam flywheel: report learned framework-key adapters this run consulted/learned (cross-stack
  // coverage that grew the deterministic floor), so they're reviewable/promotable.
  const ad = model.adapters as { used?: { name: string; scope: string }[]; learned?: string[] } | undefined;
  if (ad?.learned?.length) out.push(`Learned ${ad.learned.length} new .seam adapter(s) this run: ${ad.learned.join(", ")} — review with \`seam-adapters\`.`);
  return out.join("\n");
}
