// LLM-CONTEXT projection — a token-economical serialization of an emitted codebase seam model, for a
// DOWNSTREAM agent to consume (not a human to read). It is a pure PROJECTION of the same `seams.json`
// (no engine logic, no LLM) — the multi-client contract: one canonical model, many thin clients.
//
// It differs from the human renderings on exactly three principled axes (see docs/INTENT_CULMINATION…):
//   1. NO lossy collapsing — every off-path seam is listed (the "+N more dimmed" roll-up hides recall an
//      LLM could use); 2. CONFIDENCE not a boolean ★ — the climax is a ranked `culminationRanked` list, so
//      a consumer can hedge (the single-pick is fragile on backend flows); 3. token economy — paths +
//      roles + tables + blindspot candidates, never hunk bodies or render chrome.

import { MEDIA as _MEDIA, WAVE_VERB as _WAVE_VERB, WAVE_RANK as _WAVE_RANK, CROSS_SOURCE as _CROSS_SOURCE, CROSS_SINK as _CROSS_SINK, CROSS_KINDS as _CROSS_KINDS, STORE_KINDS as _STORE_KINDS, BOUND_KINDS as _BOUND_KINDS } from "./render/medium_registry.js";
import { debugOn } from "../core/progress.js";
import { type Hunk, type Seam, type Ranked, rolesOf, filesOf, _container, where, facts, lineageOf, memberLines, _shellOf, buildNodeIndex } from "./render/vocab.js";
import { buildDerivedIndex, computeSpine, hubKeysOf } from "./render/spine.js";
import { buildEntrySurface, INVOKE_KINDS, type EntryRay } from "./render/entry_surface.js";
export type { Hunk, Seam, Ranked };

// The 8 structural-shape renderers (consumers/deps/refactor/impact/compare/neighborhood/contract/reach)
// moved to render/shapes.ts — self-contained, no shared state with the flood/wave/agent/concern family below.
export { renderConsumerSet, renderDependencySet, renderWritersSet, renderCoupling, renderRefactorFacts, renderImpact, renderComparison, renderNeighborhood, renderContract, renderReach } from "./render/shapes.js";
// CITATION helper — one no-fabricated-line rule for EVERY `file:line` the engine prints (see render/shapes.ts).
// The seam model this family renders is 1-BASED at its source (core/lines.ts), so the value renders as-is and a
// missing/unlocated one renders as a bare path — never the `:0` these sites used to print.
import { at } from "./render/shapes.js";
import { type SnippetReader } from "./render/snippets.js";

// The region/wave/scenario render family (renderLlmContext/renderWaves/renderScenarios + their shared
// _floodParents helper) moved to render/region_views.ts — self-contained aside from the vocab/medium_registry
// imports they (and the agent/concern renderers below) all share.
export { renderLlmContext } from "./render/region_views.js";

// AGENT RENDER (Phase 3) — the ONE token-budgeted projection a coding agent reads instead of reconstructing a
// flow with a grep loop. Pure (reads only the emitted model, zero LLM, skeleton-compatible). Sections, in order:
// header · spine · region-by-tier · hubs · frontier · blindspots/unresolved. Everything a caller must TRUST —
// the spine, the collapsed hubs, the decision-point frontier, the honest gaps — is EXEMPT from budget cropping;
// only the off-path/supporting region lines (then hub sample-consumer detail) degrade, and WHAT was cropped is
// stated (I3). Reuses the same where/rolesOf/_WAVE_VERB vocabulary as the other views (one render language).
export function renderAgent(model: any, opts: { tokenBudget?: number; intent?: string; centers?: { file: string; symbol: string }[]; snippet?: SnippetReader } = {}): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  const budget = Math.max(300, opts.tokenBudget ?? 4000);
  const tok = (lines: string[]) => Math.ceil(lines.join("\n").length / 4);

  // id → label + the seam each node lives in (for reach phrases that stop at the seam boundary). Plus id → file /
  // start, so the spine can print the EXACT CALL SITE per hop (caller file:line) — the verify-by-glance the agent
  // trusts instead of re-grepping. Shared with `computeSpine` (render/spine.ts) via one derivation instead of two
  // copies — renderConcern's "## Spines" section builds the SAME index off its own footprint.
  const _idx = buildDerivedIndex(seams);
  const { label, seamOfId, fileOfId, startOfId, kindOfId, allIds, seamIds, primaryHunk, isBoundarySeam, ext: _ext } = _idx;
  // reachedVia for a SEAM: the resolved relation(s) that reached it from a node OUTSIDE the seam (same vocabulary
  // as the frontier's reachedVia — the incoming edge kind → its wave verb). Best 1–2, ranked by relation concreteness.
  const _anchorSeamId = seamOfId.get(String(model.anchor));
  const reachSeam = (s: Seam): string => {
    // For the ANCHOR seam, attribute "reached from" to the anchor NODE only, not the whole seam. A big merged
    // anchor blob (private-app `index` = 327 members) otherwise reports a call into a SIBLING as "the anchor called by X"
    // — e.g. `processOne called by signUp`, when nothing calls processOne (it's an HTTP-invoked edge fn; signUp
    // calls a sibling). Node-scoping keeps real callers (keycloak addUser ← createUser) and drops the blob leak.
    const ids = (s.id === _anchorSeamId) ? new Set([String(model.anchor)]) : seamIds(s);
    const cands: { r: number; s: string }[] = [];
    for (const e of (model.edges ?? []) as any[]) {
      const f = String(e.from), t = String(e.to);
      if (!(ids.has(t) && !ids.has(f) && allIds.has(f))) continue;
      // A RESOLVED_PARTIAL `call` edge is a NAME-MATCH lead (an unresolved receiver — "may not be your method",
      // core/resolution.ts says a PARTIAL link must not be FOLLOWED), NOT a confirmed caller. Rendering it as a flat
      // "called by X" invents callers for an over-loaded name (keycloak has 56 `createUser` methods → false callers,
      // even a self-reference). Qualify it as "possibly" and rank it AFTER grounded (FULL) callers so a real caller
      // wins the 2-slot cap. This is the render-side twin of the resolver's don't-follow-a-PARTIAL contract.
      const partialCall = e.kind === "call" && e.provenance === "RESOLVED_PARTIAL";
      const verb = partialCall ? "possibly called by" : (_WAVE_VERB[e.kind] ?? "reached from");
      cands.push({ r: _WAVE_RANK(e.kind) + (partialCall ? 0.5 : 0), s: `${verb} ${label.get(f)}` });
    }
    cands.sort((a, b) => a.r - b.r);
    const uniq = [...new Set(cands.map((c) => c.s))].slice(0, 2);
    if (uniq.length) return uniq.join(", ");
    // No in-footprint caller. Only the ACTUAL anchor is "the anchor / region root"; another node with no resolved
    // caller reached the footprint some other way (coupling / a cut UP-fan) — say so honestly, don't imply it's the anchor.
    return s.id === _anchorSeamId ? "the anchor / region root" : "no resolved caller in the footprint";
  };
  const cross = (s: Seam): string => (s.writes && s.writes.length ? `  [crossing: ${s.writes.join(", ")}]` : "");

  const tierOf = (s: Seam) => s.tier ?? "";
  // CROSS-STACK PROMOTION — a CODE seam reached via a shared-key CROSSING (HTTP route / db / queue) from within
  // the map is the OTHER SIDE of a stack boundary (Acme: the JS frontend behind the Java REST endpoint). The region
  // would bury it in off-path — but it IS the differentiator (grep can't link the two sides), so lift it into its
  // own group right after the spine. Boundary nodes (the route/table plumbing) are NOT promoted — only real code.
  // (primaryHunk/isBoundarySeam/_ext come from buildDerivedIndex above — the terminal-anchored spine keys on them too.)
  const crossInto = (s: Seam): boolean => { const ids = seamIds(s); for (const e of (model.edges ?? []) as any[]) if (_CROSS_KINDS.has(e.kind) && ids.has(String(e.to)) && !ids.has(String(e.from)) && allIds.has(String(e.from))) return true; return false; };

  // TERMINAL-ANCHORED SPINE (computed by `computeSpine`, render/spine.ts — the entry-rooted anchor→…→boundary walk,
  // an oracle-tuned algorithm shared with renderConcern's per-mechanism "## Spines" section).
  // The spine is the seam-path from the anchor DOWNSTREAM to a GROUNDED BOUNDARY sink (db-table / route / queue) —
  // the deepest one the flow PRODUCES into — NOT the emit-time `tier==="spine"` band (the BFS-deepest node, which
  // drifts to a routing terminus and buries the persistence path: Keycloak UserResource ended at the admin-client
  // routing chain while `db-table UserEntity` sat in supporting). DIRECTED along the flow (src→dst, reversed for a
  // consumers-lead footprint) so the outcome is where control/data FLOWS TO (a db-write sink), never an UPSTREAM
  // caller/inbound route — those are the ENTRY (surfaced by reachSeam's "via … from" + cross-stack), not the
  // outcome. Deterministic + structural HERE (intent picks AMONG downstream boundaries in a later pass). Rescues
  // an on-path boundary even where its identifiers embed weakly (a low-tier db-table is still the outcome). Falls
  // back to the tier band ONLY when the flow reaches NO downstream boundary (a same-language call chain / policy
  // fan) — the honest "reaches no boundary" case then renders as region-by-shell (no fabricated spine).
  // THE UPSTREAM HALF — who TRIGGERS this region, through which crossing (HTTP route / db table / queue). The
  // SAME computation `renderConcern`'s "## In" section renders (render/entry_surface.ts), not a second one: the
  // region render used to be DOWNSTREAM-ONLY ("## Mechanism"), so a "trace from X through to Y" question lost its
  // X half and a plain-text search out-answered it. Seeded from the caller's --center cluster when given, else
  // from the region ANCHOR (never a fan-in hub — the dev pointed AT the anchor).
  const _entry = buildEntrySurface(model, seams, { centers: opts.centers, anchorId: String(model.anchor) });
  const _sp = computeSpine(model, String(model.anchor), seams, _idx);
  // Merge entry + down halves (computeSpine keeps them separate so a MULTI-mechanism caller — renderConcern's
  // "## Spines" — can discard the generic entryChain and splice in its own mechanism-scoped one instead; the
  // single-anchor case here has no such ambiguity, so just merge them exactly as computeSpine used to internally).
  const spineSeams = [..._sp.entryChain, ..._sp.downSpine];
  const spineGrounded = _sp.grounded;
  const spineTerminal = _sp.terminal;
  const spineBreak = _sp.breakInfo;
  const spineAlternates = _sp.spineAlternates;
  const spineSet = new Set(spineSeams.map((s) => s.id));
  const altSet = new Set(spineAlternates.map((s) => s.id));
  const hasSpine = spineSeams.length > 0;

  const spineExts = new Set(spineSeams.map((s) => _ext(s.primary?.file)).filter(Boolean));
  const crossStack = hasSpine && spineExts.size
    ? seams.filter((s) => !spineSet.has(s.id) && !altSet.has(s.id) && !isBoundarySeam(s) && !spineExts.has(_ext(s.primary?.file)) && crossInto(s))
    : [];
  const crossSet = new Set(crossStack);

  // CO-PRODUCERS ("## Also writes") — OTHER seams that WRITE a store boundary this flow also writes: the table's
  // alternate ENTRY POINTS (Stripe/Wix webhooks writing `payments`, not just the admin routes that READ it). The
  // coupling's same-side rung surfaced them as `peer ──produce──▶ boundary` nodes; without this they sink into the
  // cropped region tail (low intent relevance). Lift them into their own EXEMPT section — "how is X processed"
  // wants every writer. Structural: a produce edge INTO a boundary the spine also produces into.
  const _PRODUCE_KINDS = new Set(["db-write", "service-write", "produce", "write", "save", "persist", "insert"]);
  const spineMemberIds = new Set<string>();
  for (const s of spineSeams) for (const h of (s.hunks ?? [])) spineMemberIds.add(String((h as any).id));
  // Match by the boundary's TABLE LABEL, not its node id: the grow draws a separate `payments` boundary node per
  // grounding call, so the spine's write-target and a co-producer's write-target are DIFFERENT node ids for the
  // SAME table. Key on label.
  // Focus on the spine's SINK table(s) — the boundary the flow TERMINATES at (`payments`) — not every table any
  // spine member happens to touch (a payment flow also writes members/admin/… → 13 tables of co-producer noise).
  const writtenTables = new Set<string>();
  for (const s of spineSeams) if (isBoundarySeam(s)) { const t = (primaryHunk(s) as any)?.label; if (t) writtenTables.add(t); }
  if (!writtenTables.size)   // fallback: a spine whose sink boundary wasn't itself made a spine seam → its members' write targets
    for (const e of (model.edges ?? []) as any[]) if (_PRODUCE_KINDS.has(e.kind) && spineMemberIds.has(String(e.from))) { const t = label.get(String(e.to)); if (t) writtenTables.add(t); }
  // Direction-agnostic: the coupling draws the produce edge as boundary──db-write──▶write-site (the co-producer
  // node is itself table-labelled), so match a member that is EITHER endpoint of a produce edge whose OTHER end
  // (or itself) carries a written-table label.
  const producesInto = (s: Seam): boolean => (s.hunks ?? []).some((h: any) => { const hid = String((h as any).id); return (model.edges ?? []).some((e: any) => _PRODUCE_KINDS.has(e.kind) && (String(e.from) === hid || String(e.to) === hid) && (writtenTables.has(label.get(String(e.from)) ?? "") || writtenTables.has(label.get(String(e.to)) ?? ""))); });
  // The co-producer write-sites are kind=`table` (the coupling labels a write-site by its table) — so we do NOT
  // exclude isBoundarySeam here (that would drop the very nodes we want). We DO drop the anchor's own module: its
  // in-flow phase writes are the main path, not an alternate entry point — a co-producer must live OUTSIDE the
  // anchor file's directory (a genuinely separate writer: a webhook, an admin route).
  const anchorDir = (seamOfId.has(String(model.anchor)) ? (fileOfId.get(String(model.anchor)) ?? "") : "").replace(/\/[^/]*$/, "");
  // test/fixture files that write the table are NOT alternate entry points. Mirrors core/resolve/consumers
  // `_TEST_RE` (llm_context is import-free by design — a pure projection); keep the two in sync if that changes.
  const _isTest = (f?: string) => !!f && /(\.(test|spec|e2e|e2e-spec|integration|integration-test)\.[a-z0-9]+$)|(-(test|spec|e2e)\.[a-z0-9]+$)|([-_.](testing|fixture|mock)\.[a-z0-9]+$)|((^|\/)(tests?|__tests__|__mocks__|mocks?|fixtures?|testing|spec|e2e|cypress|playwright)\/)|((^|\/)seed[-_.][^/]*$)/i.test(f);
  const coProducers = (process.env.SEAM_COPRODUCERS !== "0" && writtenTables.size)   // default-ON; opt-OUT via SEAM_COPRODUCERS=0
    ? seams.filter((s) => !spineSet.has(s.id) && !altSet.has(s.id) && !crossSet.has(s) && producesInto(s)
        && !!s.primary?.file && !_isTest(s.primary!.file) && !(anchorDir && (s.primary!.file!).startsWith(anchorDir + "/")))
    : [];
  const coProdSet = new Set(coProducers.map((s) => s.id));

  // ALSO READ (gated SEAM_SUBJECT_READERS) — the symmetric half of "## Also writes": the OTHER files that READ the
  // subject table (the "…and where is it displayed" side — admin lists, the member invoice page). The coupling
  // materialises them (subject-reader cap), but a file reading BOTH the subject AND a hub table gets assembled into
  // one seam labelled by the hub, and pure readers get cropped from the region — so surface them by their db-READ
  // edge to the subject boundary, in a dedicated exempt section. Excludes the anchor's own module (its reads are
  // the mechanism, not consumers) and tests.
  const _READ_KINDS = new Set(["db-read", "service-read", "consume", "read", "select", "find", "route-fetch"]);
  const readsFrom = (s: Seam): boolean => (s.hunks ?? []).some((h: any) => { const hid = String((h as any).id); return (model.edges ?? []).some((e: any) => _READ_KINDS.has(e.kind) && (String(e.from) === hid || String(e.to) === hid) && (writtenTables.has(label.get(String(e.from)) ?? "") || writtenTables.has(label.get(String(e.to)) ?? ""))); });
  // NOTE: NOT excluded by altSet — a file that both READS the subject AND reached a hub boundary as a sink (private-app
  // admin/payments/[id]: reads `payments`, joins `members`) belongs in "## Also read" on its SUBJECT read, not
  // swallowed into a `members` sink in "## Also reaches". The reader claim wins; alsoReaches drops readerSet below.
  const readers = (process.env.SEAM_SUBJECT_READERS === "1" && writtenTables.size)
    ? seams.filter((s) => !spineSet.has(s.id) && !coProdSet.has(s.id) && !crossSet.has(s) && readsFrom(s)
        && !!s.primary?.file && !_isTest(s.primary!.file) && !(anchorDir && (s.primary!.file!).startsWith(anchorDir + "/")))
    : [];
  const readerSet = new Set(readers.map((s) => s.id));

  // PIPELINE (gated SEAM_PIPELINE) — the anchor's OWN sequential downstream delegation calls, flow-ordered by
  // call-site line. For a direct-writer ORCHESTRATOR (processOne: `.update(payments)` → runPhaseProvision →
  // enrich → invoice → notify) the linear spine collapses to anchor→sink and buries the real mechanism in the
  // region, because the phases are SIBLING calls of the anchor (a fan), not nodes between anchor and sink. A
  // linear spine can't hold a fan; surface it here as a numbered sequence. Only when the anchor fans to ≥2
  // in-repo delegations (a real pipeline, not a single delegate already on the spine).
  // NODE-level: the anchor SEAM is often a big merged blob (private-app `index` = 327 members incl. the phases), so
  // anchor→phase is an INTRA-seam edge. Work from the anchor NODE's own outgoing calls to their callee NODES.
  // A DELEGATION from the anchor's body is an `import`/`call` edge carrying the USE line (the dep-graph tags a
  // used import with its call-site line, not the import statement): `import@140->runPhaseProvision`. Require a
  // real line (>0) so top-level file-refs (line 0) and pure type-refs drop out; order by line = execution order.
  const _CALL_KINDS = new Set(["call", "import", "invokes", "dispatch"]);
  const _TYPE_KINDS = new Set(["interface", "type", "enum", "type-alias"]);   // pure type-refs — not execution steps
  // MECHANISM (default-ON; opt-out SEAM_MECHANISM=0; SEAM_PIPELINE=1 kept as a back-compat alias). The anchor's
  // downstream CALL fan — the operations it drives — flow-ordered (depth, then call-site line = execution order),
  // each annotated with the grounded sink it reaches (if any). The SINK deepening surfaces the DATA outcomes (spine
  // + also-reaches); this surfaces the CALL operations that ARE the mechanism yet write NO db-table themselves: cal
  // booking's `EventManager.create` / `handlePayment` / `scheduleWorkflows` fan, which a thin anchor→one-sink spine
  // buries. TRANSITIVE (bounded depth) over call edges carrying a real use-line, so a CLASS anchor's method-body
  // calls are reached too; TYPE/FILE refs (line 0), boundary/sink nodes (shown as sinks elsewhere), and nodes
  // already ON the crowned spine path drop out. Purely structural — the anchor's resolved calls, intent-free.
  const _mechOn = process.env.SEAM_MECHANISM !== "0" || process.env.SEAM_PIPELINE === "1";
  const _mechDepth = 3;
  const _PRODUCE_MECH = new Set(["db-write", "service-write", "produce", "write", "save", "persist", "insert", "db-read", "service-read", "consume", "read"]);
  const pipeline: { id: string; line: number; depth: number; sink?: string; caller?: string }[] = [];
  if (_mechOn) {
    const anchorNode = String(model.anchor);
    const edges = (model.edges ?? []) as any[];
    const dep = new Map<string, number>([[anchorNode, 0]]);
    const callLine = new Map<string, number>();   // the call-site line of the FIRST edge that reached each step
    // PARENT — the step that CALLS this one (the `from` of the reaching edge). Two things need it, and both were
    // wrong without it: the call site's FILE (a depth-2 step is called from its PARENT's file, not the anchor's —
    // the render printed `util.ts:193` for a call that lives at getBusyTimes.ts:193, a fabricated location), and
    // the flow ORDER (below).
    const parent = new Map<string, string>();
    for (const q = [anchorNode]; q.length; ) {
      const c = q.shift()!; const d = dep.get(c)!;
      if (d >= _mechDepth) continue;
      for (const e of edges) {
        if (String(e.from) !== c || !_CALL_KINDS.has(e.kind)) continue;
        // a `call`/`invokes`/`dispatch` IS an execution step even without a call-site line (the dep-graph tags a
        // line on a USED import but not always on a resolved call — private-app runPhaseEnrich→provisionOrUpdateMember);
        // an `import` needs a real use-line to count (a bare/line-0 import is the statement, not a call).
        if (e.kind === "import" && !(Number(e.line) > 0)) continue;
        const to = String(e.to);
        if (dep.has(to) || !label.has(to) || _TYPE_KINDS.has(kindOfId.get(to) ?? "")) continue;   // resolved, non-TYPE, unseen
        dep.set(to, d + 1); callLine.set(to, Number(e.line) > 0 ? Number(e.line) : 0); parent.set(to, c); q.push(to);
      }
    }
    const sinkOf = (id: string): string | undefined => {
      for (const e of edges) if (_PRODUCE_MECH.has(e.kind) && String(e.from) === id) { const t = label.get(String(e.to)); if (t) return t; }
      return undefined;
    };
    const entries = [...dep.keys()].filter((id) => id !== anchorNode
        && !_STORE_KINDS.has(kindOfId.get(id) ?? ""))          // a sink node itself → shown in spine/also-reaches, not
        // NB: exclude by NODE, not by seam — the anchor's seam is often a merged BLOB holding its own delegations
        // (private-app runPhaseEnrich's seam also contains provisionOrUpdateMember/applyMemberSubscription); a seam-level
        // spine exclusion would drop the very operations that ARE the mechanism.
      .map((id) => ({ id, line: callLine.get(id) ?? 0, depth: dep.get(id)!, sink: sinkOf(id), caller: parent.get(id) }));
    // FLOW ORDER — the anchor's operations in EXECUTION order: at each level, by call-site line; and a step's OWN
    // callees immediately AFTER it (pre-order), because that is what "in call order" means to a reader — you
    // follow a call INTO its body, then come back for the next sibling. NB: an outcome-first sort was tried and
    // REVERTED — it hoisted grounded-sink ops but pushed the key delegation (private-app provisionOrUpdateMember, no
    // DIRECT sink) below the budget cap.
    //
    // DEPTH-MAJOR was the previous order, and it is what hid the deep call the whole mechanism exists to show:
    // a 1500-line orchestrator has ~50 depth-1 sibling calls, so EVERY depth-2 step sorted below all of them and
    // fell off the render cap. cal.com `_getAvailableSlots` reached `getBusyCalendarTimes` (depth 2) at position
    // 59 of 71 — present in the graph, invisible at any realistic token budget. Pre-order puts it directly under
    // the `BusyTimesService` step that calls into it. Within a level the sort is unchanged (line, then id), so a
    // FLAT mechanism (every step at depth 1 — the common case) renders byte-identically.
    const kids = new Map<string, typeof entries>();
    for (const e of entries.sort((a, b) => (a.line - b.line) || (a.id < b.id ? -1 : 1)))
      (kids.get(e.caller ?? anchorNode) ?? kids.set(e.caller ?? anchorNode, []).get(e.caller ?? anchorNode)!).push(e);
    // Iterative pre-order (a deep chain must not risk the JS stack), re-parenting under the nearest KEPT ancestor:
    // a filtered-out step (a store node) must not orphan the operations it calls.
    const seen = new Set<string>();
    for (const stack = [...(kids.get(anchorNode) ?? [])].reverse(); stack.length; ) {
      const e = stack.pop()!;
      if (seen.has(e.id)) continue;
      seen.add(e.id); pipeline.push(e);
      const ch = kids.get(e.id); if (ch) for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
    }
    // a step whose caller was filtered out of `entries` (a store node) is unreachable from the pre-order walk —
    // append it rather than lose it, in its own level order.
    for (const e of entries) if (!seen.has(e.id)) { seen.add(e.id); pipeline.push(e); }
  }
  const showPipeline = pipeline.length >= 2;   // a genuine multi-step mechanism, not a lone delegate the spine shows

  // SUBJECT-CONTINUITY (default-ON; opt-OUT SEAM_SUBJECT_DIM=0) — the anchor's module writes HUB tables (private-app: `members`), so its
  // members-coupling drags in UNRELATED modules that merely share that hub (support-ticket→`bug_reports`,
  // scoring-cycle→`member_social_medias`), whose OTHER tables surface as region noise. Demote a region coupling
  // seam whose TABLE isn't in the flow's SUBJECT set — the tables the anchor's own module touches (+ the spine
  // sink). Recall-safe: a DEMOTION (sinks below on-subject, out of the capped head), never a drop.
  const _tableOf = (s: Seam) => (isBoundarySeam(s) ? ((primaryHunk(s) as any)?.label ?? "") : "");
  const subjectTables = new Set<string>(writtenTables);
  for (const s of seams) { const f = s.primary?.file; if (f && anchorDir && f.startsWith(anchorDir + "/")) { const t = _tableOf(s); if (t) subjectTables.add(t); } }
  const offSubject = (s: Seam) => process.env.SEAM_SUBJECT_DIM !== "0" && !!_tableOf(s) && !subjectTables.has(_tableOf(s));

  // HUB-KEY CROSSINGS (default-ON; opt-OUT SEAM_HUB_CROSSING=1 keeps them expanded) — "these two functions both
  // touch the `user` table" is NOT a relationship in a large app: a UBIQUITOUS key is shared by a hundred unrelated
  // sites, so each such crossing carries ~no information yet costs a line and CROWDS OUT the flow. On cal.com's
  // availability trace, 190 of 358 rendered lines were `sharing a DB table with …` — `_patch.user`, the helpscout
  // sync `route.user`, signup `getServerSideProps` — while ## Mechanism, the actual answer to a "trace the flow"
  // question, was cut at step 32 of 81. The engine ALREADY measures this (it prints `(+17 hub table(s))` in the
  // header); it just didn't act on it.
  // This is a DEMOTION/FOLD, never a drop of coupling in general: a NARROW shared key is the highest-value thing
  // this render produces (the link a text search structurally cannot follow — cal.com `selectedSlots`, a Postgres
  // denormalisation trigger). Only keys the coupling itself measured as over-fanned past `COUPLING.hubFan` are
  // damped (hubKeysOf — see render/spine.ts), and only for a seam that entered the footprint BY that crossing
  // (`proposedBy === "crossing"`, the same gate the spine's crown exclusion uses) and by NOTHING narrower.
  // HONESTY: every folded crossing is counted and its hub key(s) named, with the recipe to get them back.
  const _hubSuppress = process.env.SEAM_HUB_CROSSING !== "1";
  const _hubKeys = hubKeysOf(model);
  // Every label that NAMES a shared key in this footprint — a boundary-kinded node's label, per the media registry.
  // Needed because the coupling labels a write-SITE by its table too (a `user`-labelled node of no boundary kind),
  // so the key on either end of a crossing edge is recognised by being a known key, not by that node's own kind.
  const _keyLabels = new Set<string>();
  for (const id of allIds) if (_BOUND_KINDS.has(kindOfId.get(id) ?? "")) { const l = label.get(id); if (l) _keyLabels.add(l); }
  // The KEY(S) a seam is linked into this footprint through: the known-key label on the OTHER end of every crossing
  // edge incident to it, plus its own label when that IS a key. Structural — resolved coupling edges, no matching.
  const _seamKeyCache = new Map<string, Set<string>>();
  const _seamKeys = (s: Seam): Set<string> => {
    const hit = _seamKeyCache.get(s.id); if (hit) return hit;
    const ids = seamIds(s), out = new Set<string>();
    if (s.label && _keyLabels.has(s.label)) out.add(s.label);
    for (const e of (model.edges ?? []) as any[]) {
      if (!_CROSS_KINDS.has(e.kind)) continue;
      const f = String(e.from), t = String(e.to), fi = ids.has(f), ti = ids.has(t);
      if (fi === ti) continue;                                   // both ends in (or both out) → not a crossing INTO this seam
      const l = label.get(fi ? t : f); if (l && _keyLabels.has(l)) out.add(l);
    }
    _seamKeyCache.set(s.id, out);
    return out;
  };
  // A HUB CROSSING: reached ONLY by ubiquitous key(s). ONE narrow key among them is enough to keep it expanded —
  // that is the recall-safe half of the rule. The spine, the anchor's own seam and the anchor's own module are
  // never folded (they are the flow), and neither is anything the graph reached by a real CALL (proposedBy).
  const _hubCrossing = (s: Seam): boolean => {
    if (!_hubSuppress || !_hubKeys.size) return false;
    if ((s as any).proposedBy !== "crossing" || spineSet.has(s.id) || s.id === _anchorSeamId) return false;
    if (s.primary?.file && anchorDir && s.primary.file.startsWith(anchorDir + "/")) return false;
    const k = _seamKeys(s);
    return k.size > 0 && [...k].every((x) => _hubKeys.has(x));
  };
  // Split a crossing-fed list into what stays expanded and the hub-only tail, plus the ONE honest roll-up line
  // naming the ubiquitous keys it folded and how to expand them. One mechanism, used by every such section.
  const _foldHubs = <T extends Seam>(items: T[]): { kept: T[]; note: string[] } => {
    const kept: T[] = [], dropped: T[] = [];
    for (const s of items) (_hubCrossing(s) ? dropped : kept).push(s);
    if (!dropped.length) return { kept, note: [] };
    const keys = new Set<string>(); for (const s of dropped) for (const k of _seamKeys(s)) keys.add(k);
    const names = [...keys].sort();
    return { kept, note: [`  (+${dropped.length} co-access(es) of ubiquitous key(s) folded: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ", …" : ""}`
      + ` — shared by too many unrelated sites to imply a relationship; SEAM_HUB_CROSSING=1 expands them)`] };
  };

  // SUBJECT FOLD (render-side, recall-safe) — the grow is intent-free, so a broad anchor grounds to MANY off-subject
  // crossings (private-app' payments page ↔ every admin route via the shared auth key; keycloak create-user ↔ every
  // sub-resource). A key's SUBJECT (the resource segments of its route / its table name) is a STRUCTURAL fact, so
  // fold the seams whose subject is DISJOINT from the anchor's into a per-subject COUNT, keeping the on-subject ones
  // expanded. No embeddings in the fold decision; recall-safe (a count + the subjects, never a drop). Opt out:
  // SEAM_SUBJECT_FOLD=0. This extends the existing hub-key roll-up (which folds by REPEATED label) to the far more
  // common case: DISTINCT off-subject routes that each appear once but share nothing with the anchor's domain.
  // ONLY syntax + framework-STRUCTURE words (dirs every web app has, HTTP verbs, file extensions) — NOT domain or
  // action words. Repo-specific infra (`realms`, `org.keycloak`) is dropped STRUCTURALLY below (deepest-route +
  // ubiquity), never by curating a list — so this stays language- and convention-agnostic.
  const _SUBJ_GEN = new Set(["api", "admin", "functions", "function", "dashboard", "app", "apps", "src", "lib", "libs", "services", "service", "components", "component", "pages", "page", "index", "route", "routes", "resources", "resource", "rest", "public", "internal", "common", "util", "utils", "http", "www", "get", "post", "put", "patch", "delete", "head", "options", "handler", "controller", "backend", "supabase", "shared", "tsx", "ts", "js", "jsx", "java", "mjs", "cjs", "cts", "mts", "v1", "v2", "v3"]);
  const _subjToks = (raw: string): string[] => (raw || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[/._\-\s{}()*]+/).map((x) => x.trim()).filter((x) => x.length >= 3 && !_SUBJ_GEN.has(x) && !/^\d+$/.test(x));   // split camelCase too (bookingService → booking, service) so a symbol-only subject still matches
  const _subjMatch = (a: string, b: string): boolean => a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));   // users~user, payments~payment
  const _lastTok = (raw: string): string | null => { const t = _subjToks(raw); return t.length ? t[t.length - 1] : null; };   // the DEEPEST/most-specific segment (…/realms/*/users → users, not the `realms` container)
  // per-node RAW crossing keys (the route/table on the OTHER side of a cross-stack edge) — the subject for a CODE
  // crossing whose own symbol carries no route (private-app `enrichFromExternalPayment` grounds on `/api/admin/payments`).
  const _crossKeyRaw = new Map<string, string[]>();
  for (const e of (model.edges ?? []) as any[]) {
    if (!_CROSS_KINDS.has(e.kind)) continue;
    const k = label.get(String(e.from)); if (!k) continue;
    (_crossKeyRaw.get(String(e.to)) ?? _crossKeyRaw.set(String(e.to), []).get(String(e.to))!).push(String(k));
  }
  // FILE → module tokens: its immediate PARENT DIR + basename (drops the src/apps/admin container prefix; keeps
  // process-payment/index.ts → payment, payments.ts → payments, user/CreateUser.tsx → user/create).
  const _fileToks = (f?: string): string[] => { const p = (f || "").split("/"); const base = p.pop() ?? ""; return [..._subjToks(p.pop() ?? ""), ..._subjToks(base)]; };
  // a seam's FULL token set (GENEROUS — matches if the seam TOUCHES the topic anywhere: a `/users/*/role-mappings`
  // sub-route still counts as `users`). Used for the KEEP decision.
  const _seamSubj = (s: Seam): string[] => {
    const toks = new Set<string>();
    for (const w of ((s as any).writes ?? [])) for (const t of _subjToks(String(w))) toks.add(t);
    for (const t of _subjToks(_tableOf(s))) toks.add(t);
    for (const t of _subjToks(s.primary?.symbol ?? "")) toks.add(t);
    for (const t of _fileToks(s.primary?.file)) toks.add(t);
    for (const id of seamIds(s)) for (const k of (_crossKeyRaw.get(String(id)) ?? [])) for (const t of _subjToks(k)) toks.add(t);
    return [...toks];
  };
  // a seam's PRIMARY (most-specific) subject — the DEEPEST route segment / table name (the resource, not the
  // `realms` container). The fold LABEL.
  const _seamPrimary = (s: Seam): string | null => {
    for (const id of seamIds(s)) for (const k of (_crossKeyRaw.get(String(id)) ?? [])) { const t = _lastTok(k); if (t) return t; }
    return _lastTok(_tableOf(s)) ?? (_fileToks(s.primary?.file).at(-1) ?? null) ?? _lastTok(s.primary?.symbol ?? "");
  };
  // MAIN-TOPIC by FREQUENCY CLUSTER (no keyword list → reliable across i18n / non-REST paths; ranking wrongness is
  // the reading LLM's job). Each seam's TOPIC tokens: a ROUTE contributes only its DEEPEST segment (the resource — a
  // container like `realms`/`admin` is never a leaf, so it's never the topic — a universal URL fact); symbols /
  // tables / file contribute all tokens. The main topic = the anchor's own topic tokens (ALWAYS protected) ∪ the
  // tokens SHARED by a meaningful fraction of the footprint, minus UBIQUITOUS infra (dropped by frequency, not a
  // list). We NEVER fold a seam that touches the main topic — worst case it under-folds (keeps a little noise), it
  // never hides the domain the map is about.
  const _topicToks = (s: Seam): string[] => {
    const toks = new Set<string>();
    for (const id of seamIds(s)) for (const k of (_crossKeyRaw.get(String(id)) ?? [])) { const t = _lastTok(k); if (t) toks.add(t); }
    for (const t of _subjToks(_tableOf(s))) toks.add(t);
    for (const t of _subjToks(s.primary?.symbol ?? "")) toks.add(t);
    for (const t of _fileToks(s.primary?.file)) toks.add(t);
    for (const w of ((s as any).writes ?? [])) for (const t of _subjToks(String(w))) toks.add(t);
    return [...toks];
  };
  const _N = Math.max(1, seams.length);
  const _freq = new Map<string, number>();
  for (const s of seams) for (const t of new Set(_topicToks(s))) _freq.set(t, (_freq.get(t) ?? 0) + 1);
  const _isContainer = (t: string) => (_freq.get(t) ?? 0) > 0.6 * _N;   // in most seams → ubiquitous infra, dropped structurally
  const _anchorSeamId2 = seamOfId.get(String(model.anchor));
  const _mainTopic = new Set<string>();
  for (const s of seams) if (s.id === _anchorSeamId2 || spineSet.has(s.id) || (s.primary?.file && anchorDir && s.primary.file.startsWith(anchorDir + "/")))
    for (const t of _topicToks(s)) if (!_isContainer(t)) _mainTopic.add(t);   // the anchor's OWN topic — always protected
  for (const w of subjectTables) for (const t of _subjToks(String(w))) if (!_isContainer(t)) _mainTopic.add(t);
  const _MAIN_MIN = Math.max(2, Math.floor(0.08 * _N));                         // shared by ≥8% of the footprint = a real topic
  for (const [t, n] of _freq) if (n >= _MAIN_MIN && !_isContainer(t)) _mainTopic.add(t);
  const _foldSubject = process.env.SEAM_SUBJECT_FOLD !== "0";
  const _offSubjTok = (s: Seam): string | null => {   // the subject to FOLD this seam under, or null to KEEP it
    if (!_foldSubject || !_mainTopic.size || spineSet.has(s.id)) return null;                          // never fold the spine
    const toks = _seamSubj(s); if (!toks.length) return null;                                          // no subject to judge → keep
    if (toks.some((t) => [..._mainTopic].some((m) => _subjMatch(t, m)))) return null;                  // touches the MAIN TOPIC → keep (never fold the main topic)
    return _seamPrimary(s) ?? toks[0];                                                                 // outside the topic → fold under its most-specific subject
  };
  const _foldLine = (folded: Seam[], noun: string): string => {
    const byS = new Map<string, number>();
    for (const s of folded) { const t = _offSubjTok(s) ?? "?"; byS.set(t, (byS.get(t) ?? 0) + 1); }
    const parts = [...byS.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t} ×${n}`);
    return `  (+${folded.length} off-subject ${noun} folded over: ${parts.join(", ")}${byS.size > 12 ? ", …" : ""} — name a subject as the intent to expand)`;
  };

  const supporting = seams.filter((s) => !spineSet.has(s.id) && !altSet.has(s.id) && !coProdSet.has(s.id) && !readerSet.has(s.id) && tierOf(s) !== "off" && !crossSet.has(s));
  const offSeams = seams.filter((s) => tierOf(s) === "off" && !spineSet.has(s.id) && !altSet.has(s.id) && !coProdSet.has(s.id) && !readerSet.has(s.id) && !crossSet.has(s));
  // collapsed hubs — the hub-marked hunks across the region (Phase 1); one line per hub node.
  // DEDUPE: a hub-marked hunk appears in every seam it wires (a hub wires many), so a naive scan lists it once per
  // seam — the same `BookingsBean` line a dozen times. Key by (file, label, reason) → one line per collapsed hub.
  const hubs: { label: string; file?: string; hub: any }[] = [];
  const seenHub = new Set<string>();
  for (const s of seams) for (const h of (s.hunks ?? [])) {
    const hb = (h as any).hub; if (!hb) continue;
    const k = `${h.file ?? ""}|${h.label ?? ""}|${hb.reason ?? ""}`;
    if (seenHub.has(k)) continue; seenHub.add(k);
    hubs.push({ label: h.label ?? "?", file: h.file, hub: hb });
  }
  const frontier: any[] = model.frontier ?? [];

  const q = (x: string) => (opts.intent ? ` --intent "${opts.intent}"` : x);   // the deepen invocation carries the intent to redirect

  // ---- section builders (each returns its lines) ----
  const header = (): string[] => {
    // Prefer the anchor NODE's own label (the pinned method) over the cluster label, which resolves to the bigger
    // enclosing symbol (the class) when the anchor is a member of a class-primaried seam.
    const h = [`anchor: ${label.get(String(model.anchor)) ?? cl.intent ?? model.anchor ?? "?"}`];
    if (opts.intent) h.push(`intent: ${opts.intent}`);
    // HONEST counts — most of a coupling-heavy footprint is the shared-key FAN (crossing seams + hub-fanout
    // blindspots), which the render folds. Split them out so "seams: 330 / blindspots: 215" doesn't read as chaos
    // when the body is ~90 lines: N GROUNDED seams + the coupling crossings; the ACTIONABLE blindspots + folded hubs.
    const _crossSeams = seams.filter((s) => (s as any).proposedBy === "crossing").length;
    const _bsAll = (model.blindspots ?? []) as any[];
    const _fanoutBs = _bsAll.filter((b) => b.mechanism === "shared-key-fanout").length;
    // #5 — the header count must reflect the TRULY ACTIONABLE blindspots (a deepen extends the answer): a resolvable
    // lead (a candidate set to grow into) or an on-flow dynamic dispatch. NOT the ambient bulk (external-libraries,
    // method-unattributed, flood-cap) — counting those as "actionable" (141 on the pilot's I1, all ambient) told the
    // agent there were 141 things to verify when ZERO were deepen-able, so it ignored the whole list. Same split as
    // the ## Blindspots section (leads vs ambient), surfaced honestly at the top so the agent trusts+uses it.
    const _FANOUT_H = new Set(["shared-key-fanout", "llm-proposed-key"]);
    const _ONFLOW_H = new Set(["dynamic-dispatch", "dynamic-import"]);
    const _leadBs = _bsAll.filter((b) => !_FANOUT_H.has(b.mechanism) && ((b.candidates ?? []).length || _ONFLOW_H.has(b.mechanism))).length;
    const _ambientBs = _bsAll.length - _fanoutBs - _leadBs;
    h.push(`resolution: ${model.resolutionQuality ?? "?"}`,
      `seams: ${seams.length - _crossSeams} grounded${_crossSeams ? ` + ${_crossSeams} shared-key crossing(s)` : ""}`,
      `unresolved: ${(model.unresolved ?? []).length}`,
      `blindspots: ${_leadBs} actionable${_ambientBs ? ` (+${_ambientBs} ambient)` : ""}${_fanoutBs ? ` (+${_fanoutBs} hub table(s))` : ""}`);
    const out = ["# Agent map — the region to read instead of a grep loop", h.join(" | ")];
    const im = model.intentMatch;
    if (im?.offIntent) out.push(`⚠ low intent match (top ${im.max} < ${im.floor}) — this anchor's flow may not answer the intent`);
    return out;
  };
  // The anchor NODE (model.anchor) is often assembled into a seam whose PRIMARY is a bigger sibling (e.g. the
  // enclosing class outweighs the method), so where(seam) would print the class at :0 instead of the pinned method.
  // Node-scope the anchor's own line to the anchor node's identity so `#createUser` renders as createUser:143, not
  // the class it lives in. Every OTHER seam still prints its structural primary.
  const _anchorWhere: string | null = (() => {
    const a = String(model.anchor);
    const f = fileOfId.get(a);
    if (!f) return null;
    const l = label.get(a) ?? "?";
    const c = _container(f);
    const q = c && c !== l ? `${c}.${l}` : l;
    return `${q} (${at(f, startOfId.get(a))})`;
  })();
  const seamLine = (s: Seam, n?: number) => `  ${n != null ? `${n}. ` : ""}${(s.id === _anchorSeamId && _anchorWhere) ? _anchorWhere : where(s)} — ${rolesOf(s)} — ${reachSeam(s)}${cross(s)}`;
  // THE CALL SITE between two consecutive spine seams — the resolved edge connecting them, rendered from its OWN
  // caller/callee (edge.from is always the caller, edge.line the call-site line in the caller's file — see
  // dependency_graph). So it reads `caller/File.java:41 ──call──▶ callee`, whichever spine ordering. Picks the
  // most concrete edge (a real call/write over a bare reference), falling back to the seam's own start line when a
  // derived crossing edge carries no line. Returns null when the two seams share no resolved edge.
  const spineHop = (a: Seam, b: Seam): string | null => {
    const ai = seamIds(a), bi = seamIds(b);
    // A hop INTO a data-store: the WRITE is the outcome, so prefer a produce edge (and its write line) over a
    // co-located read on the same table. "…and stored" must show the actual persist — private-app weekly_tasks reaches the
    // crown via BOTH a `.upsert` (db-write :411) and an idempotency `.select` (db-read :417); the tie on _WAVE_RANK
    // let the read win. Routes are relays, not stores, so cross-stack route hops are untouched.
    const bStore = _STORE_KINDS.has((primaryHunk(b) as any)?.kind ?? "");
    const _score = (k: string) => (bStore && _PRODUCE_KINDS.has(k)) ? -1 : (bStore && _READ_KINDS.has(k)) ? 9 : _WAVE_RANK(k);
    let best: any = null;
    for (const e of (model.edges ?? []) as any[]) {
      if (e.kind === "contains") continue;
      const f = String(e.from), t = String(e.to);
      const fwd = ai.has(f) && bi.has(t), rev = bi.has(f) && ai.has(t);
      if (!fwd && !rev) continue;
      if (!best || _score(e.kind) < _score(best.kind) || (_score(e.kind) === _score(best.kind) && e.line && !best.line)) best = e;
    }
    if (!best) return null;
    const f = String(best.from);
    const site = at(fileOfId.get(f) ?? "?", best.line || startOfId.get(f));
    return `${site} ──${best.kind}──▶ ${label.get(String(best.to)) ?? "?"}`;
  };
  // SPINE — three honest states, never a confident-but-wrong path (the trust rule): (a) GROUNDED — the anchor→sink
  // path terminating at a real boundary (db/route/queue); (b) INFERRED — no boundary was reached, so the tier band
  // is shown but LABELLED as inferred, never presented as a proven flow; (c) NONE — under an intent, an anchor that
  // reaches no downstream boundary says so (a leaf / policy / wrong center), instead of banding a fake spine.
  // #2 CULMINATIONS (intent-ranked, RENDER-time) — when the anchor's own call closure reached no CROWNABLE boundary
  // (a COMPUTE anchor: private-app' scoring `Engine` computes; a separate layer persists), the FOOTPRINT still holds
  // grounded store writes (`weekly_tasks`/`pair_weights`) that the pilot found buried in the region. Surface them,
  // most-INTENT-RELEVANT first — intent lives HERE (not in the intent-free spine), so it ranks the flow's real
  // subject to the top WITHOUT a structurally-picked wrong crown (which lands on a hub / a side-effect). Fires for
  // both "none" and the tier-band "inferred" case (neither reached a grounded sink on the anchor's own spine).
  const culmSection = (): string[] => {
    const storeSeams = seams.filter((s) => _STORE_KINDS.has((primaryHunk(s) as any)?.kind ?? "") && (primaryHunk(s) as any)?.kind !== "service");
    const seenT = new Set<string>(); const culm0: Seam[] = [];
    for (const s of [...storeSeams].sort((a, b) => (((b as any).relevance ?? 0) - ((a as any).relevance ?? 0)))) { const t = (primaryHunk(s) as any)?.label; if (!t || seenT.has(t)) continue; seenT.add(t); culm0.push(s); }
    // a store this footprint touches ONLY through a ubiquitous key is not the flow's culmination — folded, but counted.
    const { kept: culm, note } = _foldHubs(culm0);
    const head = "## Culminations (grounded writes in this footprint — intent-ranked; NOT on the anchor's own call spine, verify the link)";
    if (!culm.length) return note.length ? ["", head, ...note] : [];
    return ["", head,
      ...culm.slice(0, 6).map((s) => `  ${where(s)} — ${reachSeam(s)}`), ...(culm.length > 6 ? [`  (+${culm.length - 6} more grounded store(s))`] : []), ...note];
  };
  const spineSection = (): string[] => {
    if (!hasSpine) {
      if (!opts.intent) return [];   // no intent → no flow question → stay silent (region-by-shell speaks for itself)
      return ["", "## Spine — none: this anchor reaches no grounded boundary (db-table / route / queue) downstream.",
        "  The flow may not terminate here (a leaf / a policy or compute concern), or the center/intent is off — read the region below.",
        ...culmSection()];
    }
    const header = spineTerminal === "grounded"
      ? "## Spine (the primary path, anchor → … → outcome)"
      : spineTerminal === "frontier"
      ? "## Spine (partial — the flow continues into an opaque boundary static resolution can't follow)"
      : "## Spine (inferred — no grounded boundary reached; relevance-ordered, verify — the flow may not terminate at a boundary)";
    const out = ["", header];
    spineSeams.forEach((s, i) => {
      out.push(seamLine(s, i + 1));
      // THE CALL SITE — the exact resolved edge connecting this step to the next (caller file:line ──kind──▶
      // callee). This is the verify-by-glance line: an agent reads it instead of re-grepping to trust the hop.
      if (i < spineSeams.length - 1) { const hop = spineHop(s, spineSeams[i + 1]); if (hop) out.push(`       ↳ ${hop}`); }
    });
    // ⟂ BREAK — name where the flow left the static graph (the DI hole / unresolved edge) + the candidate impls to
    // deepen into. This is the honest terminus of a partial spine: not "here's a guess", but "it continues HERE".
    if (spineTerminal === "frontier" && spineBreak) {
      const cands = [...new Set((spineBreak.candidates ?? []).map((c: any) => (c.file ? `${c.file}#${c.symbol}` : c.symbol)).filter(Boolean))].slice(0, 4);
      out.push(`  ⟂ [${spineBreak.mechanism}: ${spineBreak.evidence}]${cands.length ? ` — candidates: ${cands.join(", ")}` : ""}`,
        `    static resolution stops here; deepen with seam --grow-from <candidate>${opts.intent ? ` --intent "${opts.intent}"` : ""}`);
    }
    // INFERRED (tier-band) spine reached no grounded sink either — surface the footprint's grounded stores, intent-ranked.
    if (spineTerminal === "none" && opts.intent) out.push(...culmSection());
    return out;
  };
  // CAPPED-LIST + overflow line — the shape every "also X" / cross-stack / pipeline / frontier section repeats:
  // render the first `cap` items, then one rolled-up "+N more <noun> — <suffix>" line if there's a remainder
  // (`extraRest` folds in an out-of-band count, e.g. frontier's server-side-truncated tally). One helper instead
  // of the same slice/forEach/overflow-line triplet hand-written per section (with the wording drifting between
  // copies — "more sink(s)" vs "more producer(s)" vs …).
  const renderCapped = <T,>(items: T[], cap: number, renderLine: (item: T, i: number) => string, noun: string,
      extraRest = 0, suffix = "raise --token-budget"): string[] => {
    const shown = items.slice(0, cap);
    const out = shown.map((item, i) => renderLine(item, i));
    const rest = (items.length - shown.length) + extraRest;
    if (rest > 0) out.push(`  (+${rest} more ${noun} — ${suffix})`);
    return out;
  };
  // ALSO REACHES — the OTHER grounded downstream sinks the intent didn't crown as primary. Shown right under the
  // spine so a wrong primary pick is one glance from correction (repoint --intent), and no real terminal is hidden.
  const alsoReachesSection = (): string[] => {
    // Drop OFF-SUBJECT sinks (a `bug_reports`/`member_social_medias` boundary reached only via a shared hub is not
    // a real alternate OUTCOME) and TEST/fixture sinks (an e2e that writes the table isn't an outcome) — they stay
    // in the region, demoted.
    const alts = spineAlternates.filter((s) => !offSubject(s) && !_isTest(s.primary?.file) && !readerSet.has(s.id));
    if (!alts.length) return [];
    // A DISTINCT-table sink is a genuinely OTHER outcome (private-app `members` — the tier culmination); an alternate that
    // shares the CROWNED spine's table (`payments` again, reached from another file) is the same sink seen elsewhere,
    // not a new answer. Float the distinct-table sinks first so the real second outcome is prominent, not buried
    // under N same-table repeats. Stable within each group by the cands order (directSink → rel).
    const _sameAsCrown = (s: Seam) => writtenTables.has(_tableOf(s));
    const sorted = [...alts].sort((a, b) => (Number(_sameAsCrown(a)) - Number(_sameAsCrown(b))));
    return ["", "## Also reaches (other grounded sinks on this flow — repoint --intent to make one the spine)",
      ...renderCapped(sorted, EXEMPT_N, (s) => seamLine(s), "sink(s)")];
  };
  // ALSO WRITES — the OTHER producers of a store boundary this flow writes: the table's alternate ENTRY POINTS
  // (a grep for the write can find these files, but not that they share THIS flow's table). Exempt from the region
  // crop (a Stripe webhook writing `payments` is a first-class answer to "how are payments processed", not tail).
  const byRelDesc = (a: Seam, b: Seam) => (((b as any).relevance ?? 0) - ((a as any).relevance ?? 0));
  const alsoWritesSection = (): string[] => {
    if (!coProducers.length) return [];
    const seen = new Set<string>();
    const uniq0 = [...coProducers].sort(byRelDesc).filter((s) => { const k = where(s); if (seen.has(k)) return false; seen.add(k); return true; });
    // co-writing a UBIQUITOUS table is not being an alternate entry point to THIS flow (cal.com: 33 `user`/`team`/
    // `schedule` writers — signup, helpscout sync, verify-email — displacing the mechanism). Fold, name, count.
    const { kept: uniq, note } = _foldHubs(uniq0);
    if (!uniq.length && !note.length) return [];
    return ["", "## Also writes (other producers of this flow's data — alternate entry points a call-trace misses)",
      ...renderCapped(uniq, EXEMPT_N, (s) => seamLine(s), "producer(s)"), ...note];
  };
  // ALSO READ — the OTHER files that read the subject table (the display/consume side): admin lists, the member
  // invoice page. Exempt from the region crop so the "…and where is it displayed" half isn't lost to a hub label.
  const alsoReadSection = (): string[] => {
    if (!readers.length) return [];
    const seen = new Set<string>();
    const uniq0 = [...readers].sort(byRelDesc).filter((s) => { const k = where(s); if (seen.has(k)) return false; seen.add(k); return true; });
    const { kept: uniq, note } = _foldHubs(uniq0);
    if (!uniq.length && !note.length) return [];
    return ["", "## Also read (where this flow's data is consumed — the display/read side)",
      ...renderCapped(uniq, EXEMPT_N, (s) => seamLine(s), "consumer(s)"), ...note];
  };
  // MECHANISM — the anchor's downstream operations in call/execution order (the CALL fan a thin one-sink spine
  // buries: EventManager.create / handlePayment / scheduleWorkflows). Numbered = flow order; each carries its call
  // site in the anchor and the grounded sink it reaches (` ──▶ table`) when it persists/reads one.
  const _anchorFileBase = (fileOfId.get(String(model.anchor)) ?? "").split("/").pop();
  // a Mechanism step whose body DISPATCHES through a runtime mechanism (dynamic-dispatch/dynamic-import blindspot):
  // annotate it with ⟂ so the reader knows the flow provably CONTINUES there into a runtime-chosen impl (and its
  // data sink) — instead of reading the sink-less step as a dead end (cal `handlePayment` → PaymentServiceMap[…]).
  const _dynDispatch = new Map<string, string>();
  for (const b of (model.blindspots ?? []) as any[]) if (b.mechanism === "dynamic-dispatch" || b.mechanism === "dynamic-import") {
    const reg = String(b.evidence ?? "").match(/`([^`]+)`/)?.[1];
    _dynDispatch.set(String(b.node), reg ? `runtime dispatch (${reg})` : "runtime dispatch");
  }
  // IN — the upstream entry surface. BUDGET: this section is EXEMPT from the degrade loop (like the spine and the
  // mechanism — a caller must be able to trust it), but it is capped at HALF the exempt-section allowance so it can
  // never crowd out the downstream mechanism steps, which keep the full EXEMPT_N: the entry surface is a FAN (a
  // shared mechanism has dozens of ways in) whereas the mechanism is a PATH, and the path is what the question asks
  // to trace. Whatever the cap drops is stated, never silently folded (the honesty contract). NO FABRICATION: only
  // entries the resolver actually grounded; if the walk found none, that is what it says.
  const inSection = (): string[] => {
    if (!_entry) return [];
    const IN_N = Math.max(4, Math.floor(EXEMPT_N / 2));
    const head = "## In (what TRIGGERS this region — the upstream entry surface; entry ──crossing──▶ ●)";
    if (!_entry.rayList.length)
      return ["", head, "  (none grounded — nothing in this region calls into the anchor and no shared-key crossing reaches it:",
        "   a framework/DI-mounted or top-level entry, or the entry is outside the grown region — widen with --max-nodes)"];
    // TIERED by evidence strength (render/entry_surface.ts): grounded call / route relay first, shared-key
    // co-access after — with a reserved slice so the coupling is never wholly invisible. `topRays` picks; the
    // residue is still counted off the FULL enumeration, so the crop stays honest.
    const shownRays = _entry.topRays(IN_N);
    return ["", head,
      `  deepen any: seam --grow-from <file>#<symbol>${opts.intent ? ` --intent "${opts.intent}"` : ""}`,
      ...renderCapped(shownRays, IN_N, (r) => _entry.entryRow(r), "way(s) in", _entry.rayList.length - shownRays.length),
      ..._entry.upstreamSection(shownRays)];
  };
  // WHICH steps survive the cap — INTENT-RANKED, at RENDER time only (the grow stays intent-free: this reorders
  // nothing in the model, it only chooses what fits). Pre-order POSITION is not relevance: on cal.com's
  // availability trace the two steps that ARE the busy-times leg the question asks for
  // (`_getBusyTimesFromLimitsForUsers`, `_getBusyTimesFromTeamLimitsForUsers`) sit at pre-order 56/57 of 81 and so
  // fell inside the truncated tail at every budget an agent actually uses — while `getHolidayEmoji` and
  // `stringToDayjs` were printed in full. A grader gave that round to plain text search.
  // The score is the DETERMINISTIC intent-relevance the model already carries (grow/intent_rank.ts: cosine of the
  // def embedding against the intent — cached, offline, no LLM call), read per NODE and falling back to the
  // node's SEAM. A step with NO score is UNKNOWN, not irrelevant, so it sits at the median (neither promoted nor
  // demoted). Ties — and the unscored — break on the original pre-order index, so the whole selection is stable:
  // same model + same budget ⇒ same steps. With no intent and no embeddings NOTHING is scored, the median rule
  // makes every step equal, and the tie-break reproduces the old head-of-list crop byte for byte.
  const _nodeRel = new Map<string, number>(), _seamRel = new Map<string, number>();
  for (const s of seams) for (const h of (s.hunks ?? [])) {
    const id = String((h as any).id); if (id === "undefined") continue;
    const hr = (h as any).relevance, sr = (s as any).relevance;
    if (typeof hr === "number" && !_nodeRel.has(id)) _nodeRel.set(id, hr);
    if (typeof sr === "number" && !_seamRel.has(id)) _seamRel.set(id, sr);
  }
  const _stepRel = (id: string): number | undefined => _nodeRel.get(id) ?? _seamRel.get(id);
  const rankSteps = <T extends { id: string }>(steps: T[], cap: number): T[] => {
    if (steps.length <= cap) return steps;
    const scores = steps.map((p) => _stepRel(p.id)).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    if (!scores.length) return steps.slice(0, cap);                       // no signal at all → the pre-order head, as before
    const mid = scores.length % 2 ? scores[(scores.length - 1) / 2] : (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2;
    const pos = new Map(steps.map((p, i) => [p.id, i]));
    const keep = new Set([...steps]
      .sort((a, b) => ((_stepRel(b.id) ?? mid) - (_stepRel(a.id) ?? mid)) || (pos.get(a.id)! - pos.get(b.id)!))
      .slice(0, cap).map((p) => p.id));
    return steps.filter((p) => keep.has(p.id));                            // …rendered back in CALL ORDER
  };
  // SNIPPETS in the mechanism (opt-in `--snippets[=N]`) — the cited source text under each step, from the SAME
  // `at(file, startOfId)` citation the step line prints (render/snippets.ts). BUDGET: snippets are a crop RUNG of
  // their own, spent BEFORE any mechanism step is cropped (see the degrade ladder below) — a prior defect let a
  // lower-value section print in full while the mechanism was cropped, and it lost a round. When the budget could
  // not hold them the section SAYS so instead of silently dropping to the bare lines (the honesty contract).
  const pipelineSection = (mechCap: number, withSnippets: boolean, overBudget: boolean): string[] => {
    if (!showPipeline) return [];
    const sr = withSnippets ? opts.snippet : undefined;
    const snipNote = !opts.snippet ? []
      : !withSnippets
        ? ["  (snippets requested but DROPPED — they did not fit the token budget; the mechanism steps are kept in"
          + " full ahead of them. Raise --token-budget to see the cited source text.)"]
        : overBudget
          ? [`  (snippets KEPT although this render EXCEEDS --token-budget ${budget}: every other section is already`
            + " at its most-cropped rung and the mechanism cap is the same with or without them, so withholding the"
            + " source text you asked for would not have bought the fit. Drop --snippets, or raise --token-budget.)"]
          : [];
    // Numbered by the step's position in the FULL call order (not in the shown subset), so a gap in the numbering
    // is the honest, readable signal that steps between them were cropped — never a silently renumbered sequence.
    const numbered = pipeline.map((p, i) => ({ ...p, n: i + 1 }));
    const shown = rankSteps(numbered, mechCap);
    const cropped = numbered.length - shown.length;
    return ["", "## Mechanism (the anchor's downstream operations, in call order — ` ──▶ sink` = what a step persists/reads; ` ⟂` = the flow continues into a runtime-chosen impl)",
      ...snipNote,
      ...renderCapped(shown, mechCap, (p) => {
        const f = fileOfId.get(p.id), where2 = f ? ` (${at(f, startOfId.get(p.id))})` : "";
        const dyn = _dynDispatch.get(p.id);
        // CALL SITE — the line lives in the file of the step's CALLER, which is the anchor's file ONLY at depth 1.
        // Printing `_anchorFileBase` unconditionally fabricated a location for every deeper step (cal.com:
        // `getBusyCalendarTimes … [called at util.ts:193]`, when the call is at getBusyTimes.ts:193). Fall back to
        // the anchor's file when the caller has none — depth-1 output is unchanged.
        const callerBase = (p.caller ? fileOfId.get(String(p.caller)) : undefined)?.split("/").pop() ?? _anchorFileBase;
        const sn = (sr && f) ? sr(f, startOfId.get(p.id), "       ") : [];
        return `  ${p.n}. ${label.get(p.id) ?? "?"}${where2}${p.sink ? ` ──▶ ${p.sink}` : ""}${dyn ? ` ⟂ ${dyn}` : ""}${callerBase && p.line ? `   [called at ${callerBase}:${p.line}]` : ""}`
          + (sn.length ? "\n" + sn.join("\n") : "");
      }, "step(s)", cropped, "the shown steps are the most intent-relevant ones; numbering is call order, so a gap = a cropped step — raise --token-budget for the rest")];
  };
  // CROSS-STACK — the promoted other-side-of-the-boundary code seams, deduped by symbol + capped. Placed right
  // after the spine (not in the region) so the shared-key link a grep can't follow is PROMINENT, per the ask.
  const crossStackSection = (): string[] => {
    if (!crossStack.length) return [];
    const seen = new Set<string>();
    const uniq0 = [...crossStack].sort(byRel).filter((s) => { const k = where(s); if (seen.has(k)) return false; seen.add(k); return true; });
    // A node reached ONLY over a ubiquitous key is coincidental co-access. A NARROW shared key is exactly the link
    // grep cannot follow and is never in _hubKeys, so it survives here untouched (the recall 45f7b7e raised).
    const { kept: uniq, note } = _foldHubs(uniq0);
    const onSub = uniq.filter((s) => !_offSubjTok(s)), offSub = uniq.filter((s) => _offSubjTok(s));
    if (!onSub.length && !offSub.length && !note.length) return [];
    const lines = ["", "## Cross-stack (the OTHER side of a shared-key boundary — grep can't link these)",
      ...renderCapped(onSub, EXEMPT_N, (s) => seamLine(s), "cross-stack node(s)")];
    if (offSub.length) lines.push(_foldLine(offSub, "crossing(s)"));
    lines.push(...note);
    return lines;
  };
  // INTENT CROP AT RENDER — the grown footprint may be the FULL structural closure (structural grow: the wave is
  // intent-free so the cache reuses across intents) or already intent-shaped (guided grow). Either way the render
  // RANKS the remaining region by intent relevance and, under budget, shows a relevance-ranked HEAD + a rolled-up
  // count — so the ON-INTENT seams stay VISIBLE (not lost in a wholesale "N cropped") while the off-intent tail
  // degrades. This is where the intent tightens a structural union without re-growing (the crop the cache moved here).
  const byRel = (a: Seam, b: Seam) => (Number(offSubject(a)) - Number(offSubject(b)))   // off-subject coupling sinks last
    || (((b as any).relevance ?? 0) - ((a as any).relevance ?? 0)) || (_shellOf(a) - _shellOf(b));
  const regionSection = (dropOff: boolean, dropSupporting: boolean): string[] => {
    const out: string[] = ["", hasSpine ? "## Region (remaining, by intent relevance)" : "## Region (by shell — nearest the anchor first)"];
    // DEDUP by symbol identity — a hub the grow reached by N paths (or a bean wired into N seams that escaped the
    // hub collapse) otherwise renders the SAME `where()` line N times (Acme: BookingsBean 4× in supporting), pure
    // noise. Keep the first (highest-relevance / nearest-shell) occurrence. Applies to BOTH the intent region and
    // the no-spine shell fallback (the fallback used to skip it → duplicate BookingsService/BookingsBean lines).
    const dedup = (list: Seam[]): Seam[] => { const seen = new Set<string>(); return list.filter((s) => { const k = where(s); if (seen.has(k)) return false; seen.add(k); return true; }); };
    if (!hasSpine) {   // no-intent / skeleton fallback: order every seam by shell (hops from the anchor)
      dedup([...seams].sort((a, b) => (_shellOf(a) - _shellOf(b)))).forEach((s) => out.push(seamLine(s)));
      return out;
    }
    // HUB-TABLE COLLAPSE — a shared-key HUB (a table like `user`/`workflowStep` touched by dozens of files) surfaces
    // as one region seam PER file, flooding the region and burying the on-intent code (cal.com: `user`×24, `team`×20).
    // Those crossings are ALREADY rolled up in the shared-key-fanout Blindspot, so keep ONE occurrence per hub label
    // and fold the rest into a single pointer line. Gated on a label carried by ≥K region seams — real code almost
    // never repeats a label that many times across distinct files, so it's the hub fan (opt out: SEAM_REGION_HUB_COLLAPSE=0).
    const _HUB_K = 6;
    const _hubCollapse = process.env.SEAM_REGION_HUB_COLLAPSE !== "0";
    const collapseHubs = (list: Seam[]): { kept: Seam[]; hubs: Map<string, number> } => {
      if (!_hubCollapse) return { kept: list, hubs: new Map() };
      const cnt = new Map<string, number>();
      for (const s of list) { const l = s.label ?? ""; if (l) cnt.set(l, (cnt.get(l) ?? 0) + 1); }
      const kept: Seam[] = [], hubs = new Map<string, number>(), seen = new Set<string>();
      for (const s of list) {
        const l = s.label ?? "";
        if (l && (cnt.get(l) ?? 0) >= _HUB_K) { if (seen.has(l)) { hubs.set(l, (hubs.get(l) ?? 0) + 1); continue; } seen.add(l); }   // keep the 1st (top-relevance), roll up the rest
        // …and the SAME fold keyed on the KEY rather than the label: the hub fan mostly arrives as DISTINCT symbols
        // (`updateProfile.handler`, `verify-email.handler`, `route.postHandler`) that share nothing but a ubiquitous
        // table, so the label-repeat test never fires on it. Keep the 1st (top-relevance) example per hub key so the
        // co-access is still VISIBLE, roll the rest into the same honest pointer line.
        else if (_hubCrossing(s)) { const k = [..._seamKeys(s)].sort()[0] ?? "?"; if (seen.has(k)) { hubs.set(k, (hubs.get(k) ?? 0) + 1); continue; } seen.add(k); }
        kept.push(s);
      }
      return { kept, hubs };
    };
    const rankedRegion = (list: Seam[], label: string, drop: boolean, headN: number): void => {
      if (!list.length) return;
      const deduped = dedup([...list].sort(byRel));
      // SUBJECT FOLD FIRST — pull the off-subject seams out before the hub-collapse + head cap, so the on-subject
      // region isn't crowded out of the head by unrelated-domain crossings that merely share the anchor's auth hub.
      const offSub = deduped.filter((s) => _offSubjTok(s));
      const { kept: sorted, hubs } = collapseHubs(deduped.filter((s) => !_offSubjTok(s)));
      const rollup = (): void => { if (!hubs.size) return; const tot = [...hubs.values()].reduce((a, b) => a + b, 0);
        out.push(`  (+${tot} more file(s) folded as shared-key hub crossings over: ${[...hubs.keys()].slice(0, 12).join(", ")}${hubs.size > 12 ? ", …" : ""} — see Blindspots)`); };
      const tail = (): void => { rollup(); if (offSub.length) out.push(_foldLine(offSub, "region seam(s)")); };
      if (!drop || sorted.length <= headN) { out.push(`${label}:`); sorted.forEach((s) => out.push(seamLine(s))); tail(); return; }
      out.push(`${label} (top ${headN} of ${sorted.length} by intent relevance — raise --token-budget for the rest):`);
      sorted.slice(0, headN).forEach((s) => out.push(seamLine(s))); tail();
    };
    rankedRegion(supporting, "supporting", dropSupporting, 10);
    rankedRegion(offSeams, "off-path", dropOff, 4);
    return out;
  };
  const hubsSection = (dropSamples: boolean): string[] => {
    if (!hubs.length) return [];
    const out = ["", "## Collapsed hubs (ubiquitous — expand explicitly if needed)"];
    for (const h of hubs) {
      const s = h.hub.sampleConsumers ?? [];
      const sample = (!dropSamples && s.length) ? `, e.g. ${s.slice(0, 3).join(", ")}` : "";
      out.push(`  ${h.label}${h.file ? ` (${h.file})` : ""} — hub: ${h.hub.reason}, fan ${h.hub.fan}${sample}`);
    }
    return out;
  };
  // CAPPED — a coupling-heavy repo has a WIDE frontier; dumping every decision point (each with a full
  // `seam --grow-from … --intent "…"` line, the intent restated every time) is what blew the output to ~90KB.
  // Show the top EXEMPT_N (scaled by budget so "raise --token-budget" is honest) and roll up the rest; state
  // the deepen recipe ONCE, not per line.
  const EXEMPT_N = Math.max(6, Math.floor(budget / 500));   // ~8 at the 4000-token default; grows with the budget
  const frontierSection = (): string[] => {
    if (!frontier.length) return [];
    return ["", "## Frontier (decision points — deepen the ones that matter)",
      `  deepen any: seam --grow-from <file>#<symbol>${opts.intent ? ` --intent "${opts.intent}"` : ""}`,
      ...renderCapped(frontier, EXEMPT_N, (f) => `  ${f.symbol} (${f.file}) — ${f.reachedVia} [${f.cutBy}]`,
        "decision point(s)", model.frontierCut ?? 0, "raise --token-budget / SEAM_FRONTIER_CAP")];
  };
  const gapsSection = (): string[] => {
    const out: string[] = [];
    const bs: any[] = model.blindspots ?? [];
    if (bs.length) {
      out.push("", "## Blindspots (what static resolution could not see — verify)");
      // SHARED-KEY-FANOUT boundaries are a CLASS, not individual leads — a coupling-heavy repo emits dozens
      // (`members` written in 17 files, `admin` in 7…). Rendered one-per-line they drown the exempt section and
      // blow the budget. COLLAPSE them to a summary that keeps the honest signal (count + the distinct keys +
      // the directive) without the flood. Non-fanout blindspots (real per-node leads) stay one-per-line — but
      // CAPPED too (a big CDI repo's @Inject fan is dozens of them), top BS_N + an honest rolled-up count.
      const FANOUT = new Set(["shared-key-fanout", "llm-proposed-key"]);
      // ON-FLOW opaque mechanisms (a candidate-less DYNAMIC DISPATCH / dynamic import ON the traced flow) carry
      // their answer in the EVIDENCE (which registry, that the sink is runtime-chosen) — route them to the
      // evidence-showing `leads` list, not the name-only ambient bucket, so "handlePayment dispatches through
      // PaymentServiceMap[…]" is visible, not collapsed to a bare node name.
      const _ONFLOW = new Set(["dynamic-dispatch", "dynamic-import"]);
      const fanout = bs.filter((b) => FANOUT.has(b.mechanism));
      const ambient = new Map<string, string[]>();
      const leads: any[] = [];
      for (const b of bs) {
        if (FANOUT.has(b.mechanism)) continue;
        if (!(b.candidates ?? []).length && !_ONFLOW.has(b.mechanism)) { (ambient.get(b.mechanism) ?? ambient.set(b.mechanism, []).get(b.mechanism)!).push(b.node); continue; }
        leads.push(b);
      }
      // SEVERITY TRIAGE — 133 blindspots is overwhelming; the actionable ones are the RESOLVABLE leads (a node
      // that resolves to one of a SMALL candidate set — a DI interface with 2 impls on the path), not the ambient
      // noise (external-libraries, already collapsed below). Rank the leads SHARPEST-first (fewest candidates = the
      // tightest "it's one of these" lead) and show the top BLINDSPOT_N; the rest roll up.
      const BLINDSPOT_N = Math.max(5, Math.floor(budget / 800));   // ~5 at the default; grows with --token-budget
      const nCands = (b: any) => new Set((b.candidates ?? []).map((c: any) => c.symbol).filter(Boolean)).size;
      const rankedLeads = [...leads].sort((a, b) => (Number(nCands(a) === 0) - Number(nCands(b) === 0))   // candidate-bearing (a resolvable set) first; opaque on-flow dispatch last
      || (nCands(a) - nCands(b)) || (String(a.mechanism) < String(b.mechanism) ? -1 : 1));
      if (rankedLeads.length) out.push(`  actionable (resolves to a known candidate set — verify these first):`);
      out.push(...renderCapped(rankedLeads, BLINDSPOT_N, (b) => {
        const cands = [...new Set((b.candidates ?? []).map((c: any) => c.file ? `${c.file}#${c.symbol}` : c.symbol).filter(Boolean))].slice(0, 6);
        return `  ${b.node}: ${b.mechanism} — ${b.evidence}${cands.length ? `; candidates: ${cands.join(", ")} (SUGGESTED)` : ""}`;
      }, "resolvable lead(s)"));
      for (const [mech, nodes] of ambient) out.push(`  ${mech} — ${nodes.length} node(s)${nodes.length <= 4 ? `: ${nodes.join(", ")}` : ""}`);
      if (fanout.length) {
        const keyOf = (b: any) => (b.candidates ?? [])[0]?.symbol ?? (String(b.evidence ?? "").match(/'([^']+)'/)?.[1]) ?? b.node;
        const keys = [...new Set(fanout.map(keyOf).filter(Boolean))];
        out.push(`  ${fanout.length} shared-key boundary crossing(s) (data-flow, not calls) over: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? `, +${keys.length - 12} more` : ""}`
          + " — to follow one, run Seam again from the OTHER side with the key as the intent.");
      }
    }
    const un: any[] = model.unresolved ?? [];
    if (un.length) { out.push("", `## Unresolved (${un.length} edge(s) static analysis couldn't follow)`); for (const u of un.slice(0, 8)) out.push(`  ${u.node ?? "?"}: ${u.query ?? ""}${u.reason ? ` (${u.reason})` : ""}`); }
    return out;
  };

  // ---- assemble; degrade OFF → supporting → hub samples → (LAST) the mechanism, never the other exempt sections (I3)
  // THE ORDER IS THE CONTRACT. For a "trace the flow" question the anchor's own call MECHANISM is the answer, and
  // the REGION TAIL is context — so the tail yields FIRST and the mechanism is the last thing cropped. Without
  // this the budget went the other way round: the region printed its full off-path list (165 lines of co-access)
  // while the mechanism stopped at step 34 of 84, which is the shape of output a plain text search out-scored.
  // It also keeps the hub-crossing fold HONEST at the whole-render level: folding a hundred `user`/`team`
  // co-accesses must give the budget back to the flow, not simply let the region tail expand to refill it.
  const assemble = (dropOff: boolean, dropSupporting: boolean, dropSamples: boolean, snippets: boolean, mechCap: number, overBudget = false): string[] =>
    [...header(), ...spineSection(), ...inSection(), ...pipelineSection(mechCap, snippets, overBudget), ...alsoReachesSection(), ...alsoWritesSection(), ...alsoReadSection(), ...crossStackSection(), ...regionSection(dropOff, dropSupporting), ...hubsSection(dropSamples), ...frontierSection(), ...gapsSection()];
  // MECH_FULL = the whole mechanism; the final rung falls back to the generic EXEMPT_N allowance, where the
  // intent-relevance ranking above decides WHICH steps survive.
  const MECH_FULL = pipeline.length;
  // The SNIPPET rung sits between "everything else is already cropped" and "crop the mechanism": opt-in source
  // text is worth less than a step that would otherwise disappear, so it yields FIRST and the step count is the
  // last thing to go — the same priority that put the mechanism last among the sections.
  const steps: [boolean, boolean, boolean, boolean, number][] = [
    [false, false, false, true, MECH_FULL], [true, false, false, true, MECH_FULL], [true, true, false, true, MECH_FULL],
    [true, true, true, true, MECH_FULL], [true, true, true, false, MECH_FULL], [true, true, true, false, EXEMPT_N]];
  let out: string[] = [], fitted = false;
  for (const step of steps) { out = assemble(...step); if (tok(out) <= budget) { fitted = true; break; } }   // first fitting crop level, else the most-cropped
  // NOTHING fits: the sections that are EXEMPT from cropping already exceed the budget on their own. At that
  // point dropping the caller's EXPLICITLY requested snippets bought no fit — the render overruns either way and
  // the mechanism cap is EXEMPT_N in both — so withholding them is pure loss, not a saving. Give the caller what
  // they asked for and let the section SAY the render is over budget (crop stated, never silent).
  if (!fitted && opts.snippet) out = assemble(true, true, true, true, EXEMPT_N, true);
  return out.join("\n");
}

// CONCERN RENDER (prototype) — a CENTER-first projection for plural "how is X managed?" questions, where the
// answer is a STAR (a shared mechanism + the interactions around it) not a linear flow. The center is found
// STRUCTURALLY: the node with the highest fan-in (most consumers) in the intent-region — on Acme, the
// `BookingsBean` every interaction delegates through. Its consumers (each walked up to its entry point) are the
// INTERACTIONS, ranked by intent tier. Pure projection of an already-grown model (no re-grow) — validates whether
// the star FRAMING reads better than the flow map on a concern; the full plan re-anchors the grow on the center.
// NOTE: unlike renderAgent, this view crops by 3 independent caps (interactionCap/_VIAS/_OPS)
// rather than a token budget — there is no `opts.tokenBudget` here (a prior version declared but never read
// one; if real token-budget cropping is wanted for this view, it needs its own degrade loop, not a bare flag).
export function renderConcern(model: any, opts: { intent?: string; centers?: { file: string; symbol: string }[];
    // Render bounds — PARAMETERS, not environment. They were SEAM_CONCERN_CAP / SEAM_CONCERN_SPINE_CAP,
    // which only this render read and only its tests set.
    interactionCap?: number; spineCap?: number } = {}): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  // Same derived index `computeSpine` (render/spine.ts) needs — reused here so a per-mechanism "## Spines" line can
  // trace ITS OWN entry→…→boundary path (the same oracle-tuned walk renderAgent uses for its single anchor).
  const _spineIdx = buildDerivedIndex(seams);
  const edges = (model.edges ?? []) as any[];
  // THE ENTRY SURFACE (render/entry_surface.ts) — the node index, the call/invoke/crossing adjacency, the center
  // cluster, the entry climb and the ranked "ways in" (rays). Extracted so `renderAgent`'s "## In" section renders
  // the SAME grounded upstream facts from the SAME computation (one implementation, two renders) — a "trace from X
  // through to Y" question needs both directions, and the region render used to carry only the downstream half.
  const _es = buildEntrySurface(model, seams, { centers: opts.centers });
  if (!_es) return "(empty region)";
  const { hunkById, seamOf, nodes, callIn, crossAdj, fanIn, centerRel, tierRank, isBoundaryNode, crossingEdge,
    qual, where, fileClass, symLike, entryOf, invokersOf, centerIds, centerSet, mechNodes, primary, matchNode,
    rayList, viasStr, entryRow } = _es;
  // ALL distinct entry flows into a mechanism — NOT one (the "## Flows" fan; concern-only, so it stays here).
  // A shared bean is genuinely reached by MANY independent flows, and WHICH one matters is a semantic call that
  // belongs to the consuming agent, not the engine (CLAUDE.md: structure ENUMERATES, the model JUDGES). Reverse-walk
  // the INVOCATION graph up from the mechanism, node-scoped, HALTING at another mechanism (a sibling bean method is
  // its own entry in the star) and at a root (a node nothing in-repo invokes — a REST endpoint / a framework/DI
  // mount). Each root is one entry flow; return the path root → … → (direct caller of the mechanism) for each.
  const entryFlowsOf = (cid: string): string[][] => {
    const parent = new Map<string, string>();   // node → the node it invokes toward the mechanism
    const visited = new Set<string>([cid]);
    const roots: string[] = [];
    const q = [cid];
    while (q.length) {
      const n = q.shift()!;
      const callers = invokersOf(n).filter((c) => !visited.has(c) && !mechNodes.has(c));   // don't cross into a sibling mechanism
      if (n !== cid && !callers.length) { roots.push(n); continue; }                        // nothing invokes n → n is an entry root
      for (const c of callers) { visited.add(c); parent.set(c, n); q.push(c); }
    }
    const flows: string[][] = [];
    for (const r of roots) { const path: string[] = []; for (let cur: string | undefined = r; cur !== undefined && cur !== cid; cur = parent.get(cur)) path.push(cur); flows.push(path); }
    // deterministic order: cross-stack (a real screen behind the root) first, then spine tier, then by entry label.
    return flows.sort((a, b) => (Number(!!frontEndEntryOf(a[0])) - Number(!!frontEndEntryOf(b[0]))) * -1
      || (tierRank(seamOf.get(a[a.length - 1])) - tierRank(seamOf.get(b[b.length - 1])))
      || (String(hunkById.get(a[0])?.label) < String(hunkById.get(b[0])?.label) ? -1 : 1));
  };
  // the produce VERB for an outcome, by boundary kind — publishes to a queue/topic/event, calls out to an egress,
  // writes to a store (db/cache/file). Keeps the co-equal culmination fan reading naturally per medium.
  const _outcomeVerb = (bid: string): string => { const k = hunkById.get(bid)?.kind ?? ""; return k === "egress" ? "calls out" : (k === "queue" || k === "event" || k === "topic") ? "publishes" : "writes"; };
  // OUT crossings — the boundaries the MECHANISM itself produces to / consumes: the db table it writes, the queue it
  // publishes — the "what a booking DOES" half of the star. Direction from the crossing edge (_CROSS_SOURCE =
  // code→boundary = writes; _CROSS_SINK = boundary→code = reads). Rendered as `● ──writes──▶ db "Booking"`.
  // Attribute each boundary crossing to the MECHANISM node it fans out of (the class method), not just the
  // boundary — so a per-method star renders `BookingsBean.createBooking ──writes──▶ db "MemberBooking"` (which
  // method does what), and de-dup by (mechanism, verb, boundary): several write SITES of the same table under one
  // method are one fact, so we don't repeat `● ──writes──▶ db "MemberBooking"` per call site.
  const outCross: { mech: string; verb: string; bid: string }[] = [];
  for (const e of edges) {
    if (!_CROSS_KINDS.has(e.kind)) continue; const f = String(e.from), t = String(e.to);
    if (mechNodes.has(f) && isBoundaryNode(t)) outCross.push({ mech: f, verb: _CROSS_SOURCE.has(e.kind) ? "writes" : "reads", bid: t });
    else if (mechNodes.has(t) && isBoundaryNode(f)) outCross.push({ mech: t, verb: _CROSS_SINK.has(e.kind) ? "reads" : "writes", bid: f });
  }
  const cap = Math.max(1, opts.interactionCap ?? 50);   // a big concern stays scannable
  const q = opts.intent ? ` --intent "${opts.intent}"` : "";
  // DIAGNOSTIC (SEAM_DEBUG=fp): the FULL interaction list before the cap + which are CUT. "Why is X missing":
  // absent here = not enumerated (grow/coupling gap); present-but-CUT = raise interactionCap; in a `via` list =
  // it reaches the mechanism through that entry (now shown, not silently folded away).
  if (debugOn("fp")) {
    const w = (s: string) => process.stderr.write(s + "\n");
    w(`[concern] mechanisms: ${[...mechNodes].filter((c) => centerSet.has(c)).map((c) => qual(hunkById.get(c))).join(", ")} | +${mechNodes.size - centerSet.size} method node(s) in scope`);
    w(`[concern] interactions: ${rayList.length} enumerated, cap ${cap}`);
    rayList.forEach((r, i) => w(`[concern]   ${i < cap ? "show " : "CUT  "}${qual(hunkById.get(r.entry))} [${seamOf.get(r.entry)?.tier ?? "?"}] — via ${viasStr(r)}`));
    // GROWN-BUT-UNSHOWN: a code node in the footprint that is neither a mechanism/operation nor an interaction
    // (entry or folded via). Its callIn/cross counts say WHY: callIn=0 & cross=0 → an orphan the grow reached by
    // some other edge (not a call-consumer of the mechanism, not a crossing counterpart) → the concern is
    // center-centric and it isn't wired to the center; cross>0 → a coupling counterpart the boundary scan didn't
    // reach (its boundary isn't on the mechanism's upstream). This is the "AcmeCheckBookingsService / CRUD
    // route grown but absent" probe.
    const shownIds = new Set<string>([...mechNodes, ...rayList.map((r) => r.entry)]);
    for (const cid of mechNodes) for (const c of (callIn.get(cid) ?? [])) if (!mechNodes.has(c) && shownIds.has(entryOf(c))) shownIds.add(c);
    const unshown = nodes.filter((id) => { const h = hunkById.get(id); return h?.file && symLike(h.label) && !shownIds.has(id); });
    w(`[concern] grown-but-unshown code node(s): ${unshown.length}`);
    for (const id of unshown.slice(0, 60)) { const h = hunkById.get(id); w(`[concern]   unshown ${qual(h)} (${h.file}) [${seamOf.get(id)?.tier ?? "?"}] callIn=${callIn.get(id)?.size ?? 0} cross=${crossAdj.get(id)?.size ?? 0}`); }
  }
  const out: string[] = [];
  // MECHANISMS — render EVERY picked center (opts.centers), so the header count matches the pick. A center the
  // grow reached shows its fan-in; one the node budget didn't expand is still listed (picked, not reached) so the
  // agent knows it's part of the concern. Falls back to the detected centerIds when no centers were passed.
  // OPERATIONS — a mechanism is usually a CLASS/bean; its own METHODS present in the footprint (grown as its
  // deps) ARE the answer to "how is X managed" (createBooking / cancelBooking / …), but the center line only
  // names the class, so they were invisible — the dev saw a bare `BookingsBean` and none of its operations.
  // List the methods the region holds under each mechanism (structural: hunk.enclosing === the center's label),
  // capped + counted so a fat bean stays scannable. A leading `→` marks the intent-relevant ones (spine tier).
  const _OPS_CAP = 16;
  const opsOf = (label: string): string[] => {
    if (!label) return [];
    const ops: { name: string; spine: boolean }[] = [];
    const seen = new Set<string>();
    for (const id of nodes) { const hh = hunkById.get(id); if (hh?.enclosing === label && hh.label && !seen.has(hh.label)) { seen.add(hh.label); ops.push({ name: hh.label, spine: seamOf.get(id)?.tier === "spine" }); } }
    return ops.sort((a, b) => (Number(b.spine) - Number(a.spine)) || (a.name < b.name ? -1 : 1)).map((o) => (o.spine ? `→${o.name}` : o.name));
  };
  const mechLine = (h: any, cid: string | null | undefined): string => {
    const head = `  ${where(h)} — fan-in ${cid ? fanIn(cid) : 0} consumer(s)${h?.hub ? ` — hub (${h.hub.reason}, fan ${h.hub.fan})` : ""}`;
    const ops = opsOf(h?.label);
    return ops.length ? `${head}\n      operations: ${ops.slice(0, _OPS_CAP).join(", ")}${ops.length > _OPS_CAP ? `, … (+${ops.length - _OPS_CAP} more)` : ""}` : head;
  };
  const mechLines: string[] = [];
  if (opts.centers?.length) {
    for (const c of opts.centers) { const cid = matchNode(c); const h = cid ? hunkById.get(cid) : null;
      mechLines.push(h ? mechLine(h, cid) : `  ${c.symbol} (${c.file}) — picked, not reached in this region`); }
  } else for (const cid of centerIds) mechLines.push(mechLine(hunkById.get(cid), cid));
  const mechCount = opts.centers?.length ?? centerIds.length;
  // `●` = the mechanism (the star's center). Interactions thread INTO it (In); the center's own boundary writes
  // fan OUT of it (Out) — the two halves that read as flows around the center.
  const dot = mechCount > 1 ? "●" : `● ${qual(primary)}`;
  out.push("# Concern map — the mechanisms and the interactions around them",
    [`concern: ${opts.intent ?? primary?.label ?? "?"}`, `mechanisms: ${mechCount}`, `resolution: ${model.resolutionQuality ?? "?"}`,
      `interactions: ${rayList.length}`, `blindspots: ${(model.blindspots ?? []).length}`].join(" | "));
  out.push("", `## Mechanisms ● (the concern's shared beans — the star's center${mechCount > 1 ? " cluster" : ""})`, ...mechLines);
  // FLOWS — per mechanism: its shared DOWNSTREAM culmination (mechanism → … → boundary, from `computeSpine`'s
  // down-half, render/spine.ts — the SAME oracle-tuned anchor→sink walk `renderAgent` uses) stated ONCE, then a
  // FAN of EVERY distinct way in (entryFlowsOf). A shared bean is reached by many independent flows (the adviser
  // portal, the member portal, a login-setup, an XPlan sync); WHICH one matters is the agent's semantic call, so
  // the engine ENUMERATES them all deterministically (capped) rather than picking one. Top-N mechanism by fan-in
  // (`centerIds` is fan-sorted, and reflects `opts.centers`' order when the caller pinned a set).
  const _spineCap = Math.max(1, opts.spineCap ?? 5);
  // CROSS-STACK FRONT-END of a backend entry node — the "screen" end of "screen → … → database". The per-mechanism
  // call-graph climb (entryChainOf) reaches the top BACKEND node (a REST method), but stops there — `callIn` is
  // call-graph only, so it never crosses the HTTP boundary to the UI that actually triggers the flow. This adds the
  // ONE grounded hop the single-anchor spine already makes: backend --route-serve--> /route --route-fetch--> UI,
  // TWO hops over the crossing graph (crossAdj) through a route boundary to a counterpart on the OTHER stack (a
  // different file extension). Matched by route SPECIFICITY: a boundary with the FEWEST cross-stack counterparts is
  // the method's OWN leaf route (/booking/update → one UI), preferred over a shared class base (/booking → every
  // sibling UI); the deeper route path breaks a tie. Returns the UI node + the boundary (for the ──HTTP /route──▶
  // edge), or null for a pure-backend concern (no prefix — unchanged). GROUNDED: a real resolved route crossing.
  const frontEndEntryOf = (backendId: string): { feId: string; bid: string } | null => {
    const beExt = _spineIdx.ext(hunkById.get(backendId)?.file);
    const sameStack = (n: string): boolean => { const x = _spineIdx.ext(hunkById.get(n)?.file); return !isBoundaryNode(n) && hunkById.has(n) && x === beExt; };
    const isCrossFE = (fe: string): boolean => { const x = _spineIdx.ext(hunkById.get(fe)?.file); return !isBoundaryNode(fe) && hunkById.has(fe) && !!x && x !== beExt; };
    // SPECIFICITY, primary discriminator: the number of SAME-STACK backend nodes serving a route. A method's own
    // leaf route (@Path("/create")) is served by ONE method (+ its class), a shared class base (@Path("/booking"))
    // by EVERY sibling method — so the route with the FEWEST backend servers is the one that uniquely names THIS
    // mechanism's UI. Then fewer cross-stack counterparts, then the deeper route path, then a stable label tiebreak.
    let best: { feId: string; bid: string; servers: number; fan: number; spec: number } | null = null;
    for (const bid of (crossAdj.get(backendId) ?? [])) {
      if (!isBoundaryNode(bid)) continue;
      const nbrs = [...(crossAdj.get(bid) ?? [])];
      const fes = nbrs.filter(isCrossFE).sort();   // sorted → deterministic
      if (!fes.length) continue;
      const servers = nbrs.filter(sameStack).length;
      const spec = String(hunkById.get(bid)?.label ?? "").split("/").filter(Boolean).length;
      const cand = { feId: fes[0], bid, servers, fan: fes.length, spec };
      if (!best || cand.servers < best.servers
          || (cand.servers === best.servers && (cand.fan < best.fan
          || (cand.fan === best.fan && cand.spec > best.spec)))) best = cand;
    }
    return best ? { feId: best.feId, bid: best.bid } : null;
  };
  // ALL cross-stack front-ends reaching a backend node — every distinct UI (not one), each with its most-specific
  // route. A REST handler with no in-repo caller is entered ONLY via its route(s), so a mechanism that is itself a
  // route handler (the concern centered on the REST layer) has its ways-in HERE, not in the call graph — this is
  // what makes the front-end a first-class way in rather than a footnote in "## In". Deduped per UI (a UI hitting
  // two routes shows once, on its most-specific — fewest-backend-server — route).
  const frontEndsOf = (backendId: string): { feId: string; bid: string }[] => {
    const beExt = _spineIdx.ext(hunkById.get(backendId)?.file);
    const sameStack = (n: string): boolean => { const x = _spineIdx.ext(hunkById.get(n)?.file); return !isBoundaryNode(n) && hunkById.has(n) && x === beExt; };
    const isCrossFE = (fe: string): boolean => { const x = _spineIdx.ext(hunkById.get(fe)?.file); return !isBoundaryNode(fe) && hunkById.has(fe) && !!x && x !== beExt; };
    // group the backend's route boundaries by SERVER COUNT, keep only the MOST-SPECIFIC (fewest backend servers):
    // a method's own leaf route (/create — served by one method + its class) uniquely names its UI, while a shared
    // class base (/csbooking — served by every sibling method) would pull in sibling UIs that never trigger THIS
    // handler (csSaveBooking appearing as a false way in to csCreateBooking). Then take ALL UIs on those routes.
    const routes: { bid: string; uis: string[]; servers: number }[] = [];
    for (const bid of (crossAdj.get(backendId) ?? [])) {
      if (!isBoundaryNode(bid)) continue;
      const nbrs = [...(crossAdj.get(bid) ?? [])];
      const uis = nbrs.filter(isCrossFE);
      if (uis.length) routes.push({ bid, uis, servers: nbrs.filter(sameStack).length });
    }
    if (!routes.length) return [];
    const minServers = Math.min(...routes.map((r) => r.servers));
    const seen = new Set<string>(); const out: { feId: string; bid: string }[] = [];
    for (const r of routes.filter((r) => r.servers === minServers)) for (const ui of [...r.uis].sort()) { if (seen.has(ui)) continue; seen.add(ui); out.push({ feId: ui, bid: r.bid }); }
    return out;
  };
  // DELEGATION CHAIN from a mechanism to the code that actually WRITES the boundary — the intermediate beans the
  // culmination must show. `computeSpine` compresses its down-path to a 1-hop `anchor → sink` when the write is a
  // delegate's directSink (the BFS can't traverse the fwd-reversed call chain), so a REST method that persists
  // THROUGH a bean (BookingsResource.updateBooking → BookingsBean.updateBooking → … → em.merge) rendered as
  // `● BookingsResource.updateBooking → db` with the bean missing (the reported gap). Trace the FORWARD invocation
  // edges from the mechanism to the nearest node that produces into a store boundary, so the bean is on the line.
  const _PRODUCE_KINDS_C = new Set(["db-write", "service-write", "produce", "write", "save", "persist", "insert"]);
  const invokeFwd = new Map<string, Set<string>>();
  for (const e of edges) { if (!INVOKE_KINDS.has(e.kind)) continue; const f = String(e.from), t = String(e.to);
    (invokeFwd.get(f) ?? invokeFwd.set(f, new Set()).get(f)!).add(t); }
  const isStoreBid = (id: string): boolean => _STORE_KINDS.has(hunkById.get(id)?.kind ?? "");
  const writersTo = (bid: string): string[] => edges.filter((e) => (_PRODUCE_KINDS_C.has(e.kind) || _CROSS_SOURCE.has(e.kind)) && String(e.to) === bid).map((e) => String(e.from));
  const callPath = (from: string, to: string): string[] | null => {
    if (from === to) return [from];
    const parent = new Map<string, string>(); const vis = new Set([from]); const q = [from];
    while (q.length) { const n = q.shift()!; for (const nb of invokeFwd.get(n) ?? []) { if (vis.has(nb)) continue; vis.add(nb); parent.set(nb, n); if (nb === to) { const p: string[] = []; for (let c: string | undefined = to; c !== undefined; c = parent.get(c)) p.unshift(c); return p; } q.push(nb); } }
    return null;
  };
  // the mechanism → … → writer path for the boundary `bid` (shortest reachable writer); null if the mechanism
  // itself is the writer or no writer is call-reachable (then the compressed computeSpine path stands).
  const _nf = (f?: string): string => (f ? String(f).replace(/^\.\//, "") : "");
  const delegationChain = (cid: string, bid: string): string[] | null => {
    if (!isStoreBid(bid)) return null;
    const writers = writersTo(bid);
    let best: string[] | null = null;
    // skip `cid` itself as a write target (a coupling often attributes the delegate's write UP to the caller too),
    // but keep looking for a DEEPER writer the mechanism reaches through calls — that's the real bean to surface.
    for (const w of writers) { if (w === cid) continue; const p = callPath(cid, w); if (p && p.length > 1 && (!best || p.length < best.length)) best = p; }
    if (best) return best;
    // FALLBACK — no traced writer is call-reachable (the coupling keeps ONE representative write site per table, so
    // a sibling method's own write carries no edge). Trace to the nearest node in a WRITER'S FILE — the bean the
    // mechanism delegates to (whose sibling holds the representative write) — so the delegate still shows instead
    // of a bare `mechanism → db`.
    const wFiles = new Set(writers.map((w) => _nf(hunkById.get(w)?.file)).filter(Boolean));
    if (!wFiles.size) return null;
    const parent = new Map<string, string>(); const vis = new Set([cid]); const q = [cid];
    while (q.length) { const n = q.shift()!; for (const nb of invokeFwd.get(n) ?? []) { if (vis.has(nb)) continue; vis.add(nb); parent.set(nb, n);
      if (wFiles.has(_nf(hunkById.get(nb)?.file))) { const p: string[] = []; for (let c: string | undefined = nb; c !== undefined; c = parent.get(c)) p.unshift(c); return p.length > 1 ? p : null; }
      q.push(nb); } }
    return null;
  };
  // ALL co-equal CULMINATIONS of a mechanism — every grounded boundary its flow produces into, not just the one
  // the spine crowns. An orchestrator has MANY ends (a db write, a queue publish, an external HTTP egress); which
  // matters is the agent's call, so the engine enumerates them all (the output-side mirror of the way-in fan).
  // Each: the boundary + the delegation chain from the mechanism to the writer (so the delegate bean shows).
  const _PRODUCE_CROSS = new Set<string>([..._CROSS_SOURCE]);   // code→boundary produce crossings (db-write/queue-publish/egress-call/…)
  const culminationsOf = (cid: string): { bid: string; chain: string[] }[] => {
    const reach = new Set<string>([cid]); const q = [cid];   // forward invocation closure from the mechanism
    while (q.length) { const n = q.shift()!; for (const nb of invokeFwd.get(n) ?? []) if (!reach.has(nb)) { reach.add(nb); q.push(nb); } }
    // a produce crossing is often attributed to the CLASS node (reached via import, not invocation) — e.g. the JMS
    // queue-publish sits on `JmsQueueSender`, not the reached `send` method. So ALSO count a boundary produced by a
    // CLASS node whose file is reached (delegationChain then traces to the real method within it). Restricted to a
    // CLASS node — NOT a sibling METHOD in a reached file (a co-located `updateProfile` writing another table is a
    // different mechanism's outcome, not this one's).
    const reachFiles = new Set([...reach].map((n) => _nf(hunkById.get(n)?.file)).filter(Boolean));
    const _isClassNode = (id: string): boolean => { const h = hunkById.get(id); if (!h?.file || !h.label) return false; const base = String(h.file).split("/").pop()?.replace(/\.\w+$/, "") ?? ""; return h.label === (fileClass.get(h.file) ?? base); };
    const bids = new Map<string, string>();   // (kind|label) → one node id — dedup the duplicate boundary nodes (a db-table often has two: the @Entity class + the write site, same label)
    for (const e of edges) { const f = String(e.from), t = String(e.to);
      if (_PRODUCE_CROSS.has(e.kind) && isBoundaryNode(t) && (reach.has(f) || (_isClassNode(f) && reachFiles.has(_nf(hunkById.get(f)?.file))))) { const h = hunkById.get(t); const k = `${h?.kind}|${h?.label}`; if (!bids.has(k)) bids.set(k, t); } }
    const out = [...bids.values()].map((bid) => ({ bid, chain: delegationChain(cid, bid) ?? [cid] }));
    // deterministic order: stores (db/cache/file) first, then queue/event, then egress last; then AGGREGATE ROOT
    // before its FK-CHILD detail (a co-present child entity holds a @ManyToOne to its parent — model.entityParents;
    // GroupEntity before GroupAttributeEntity, UserEntity before UserRoleMappingEntity), then by boundary label.
    const _rank = (bid: string): number => { const k = hunkById.get(bid)?.kind ?? ""; return k === "egress" ? 2 : (k === "queue" || k === "event" || k === "topic") ? 1 : 0; };
    const _entParents: Record<string, string[]> = (model.entityParents ?? {});
    const _fanLbls = new Set(out.map((o) => String(hunkById.get(o.bid)?.label)).filter(Boolean));
    const _childInFan = (bid: string): number => { const l = String(hunkById.get(bid)?.label); return (_entParents[l] ?? []).some((p) => p !== l && _fanLbls.has(p)) ? 1 : 0; };
    return out.sort((a, b) => (_rank(a.bid) - _rank(b.bid)) || (_childInFan(a.bid) - _childInFan(b.bid)) || (String(hunkById.get(a.bid)?.label) < String(hunkById.get(b.bid)?.label) ? -1 : 1));
  };
  const spineLines: string[] = [];
  if (mechCount > 1) {   // a single-mechanism concern already has the full agent spine one `--format agent` away
    const _spineCenters = centerIds.slice(0, _spineCap);
    for (const cid of _spineCenters) {
      const sp = computeSpine(model, cid, seams, _spineIdx);
      if (!sp.downSpine.length || sp.terminal === "none") continue;   // no traceable path → stays the flat one-liner above
      // A grounded spine's LAST seam IS the crowned boundary itself (computeSpine only crowns a boundary seam —
      // see `cands = seams.filter((s) => isBoundarySeam(s) ...)` in render/spine.ts) — drop it from the code chain
      // so the boundary is named ONCE, via the `──verb──▶ db "Table"` edge (not twice: once as a bare chain step,
      // once as the edge target).
      const downSteps = sp.terminal === "grounded" ? sp.downSpine.slice(0, -1) : sp.downSpine;
      // NODE-SCOPE the first step to the mechanism's OWN hunk, not the seam's structural primary — computeSpine
      // guarantees downSpine[0] is the anchor's own seam, but a seam is often a merged blob (the method fused
      // with a shared dispatcher class), so its primaryHunk can be a BIGGER SIBLING (AcmeJsonSchemaBean)
      // instead of this specific method. Same fix as renderAgent's `_anchorWhere` (line ~363), applied per
      // mechanism here — without it, every fanned method whose blob's primary is that sibling renders the SAME
      // label, making genuinely different CRUD operations (createBooking/updateBooking/cancelBooking) collapse
      // into identical, indistinguishable lines.
      // CULMINATION FAN — every CO-EQUAL end the mechanism's flow produces into (db + queue + external egress),
      // not just the one computeSpine crowns. `● mechanism` heads the block; each `⇒ [delegate chain] ──verb──▶
      // boundary` is one outcome. The delegate bean is on each chain (delegationChain), so an orchestrator reads
      // its full fan-out. Single-outcome mechanisms stay compact (the ⇒ folds onto the ● line).
      const _culmCap = 6;
      const _renderChain = (chain: string[]): string => {   // qualify + cap the delegate chain (drop the leading mechanism — it's the ●)
        let ids = chain[0] === cid ? chain.slice(1) : chain;
        if (ids.length > _culmCap) ids = [...ids.slice(0, _culmCap - 2), `…(+${ids.length - _culmCap})`, ids[ids.length - 1]];
        return ids.map((id) => (id.startsWith("…") ? id : qual(hunkById.get(id)))).join(" → ");
      };
      const culms = sp.terminal === "grounded" ? culminationsOf(cid) : [];
      if (culms.length > 1) {
        spineLines.push(`  ● ${qual(hunkById.get(cid))}  (${culms.length} outcomes)`);
        for (const c of culms) { const chain = _renderChain(c.chain); spineLines.push(`      ⇒ ${chain ? `${chain} ` : ""}──${_outcomeVerb(c.bid)}──▶ ${crossingEdge(c.bid)}`); }
      } else if (culms.length === 1) {
        const c = culms[0]; const chain = _renderChain(c.chain);
        spineLines.push(`  ● ${qual(hunkById.get(cid))}${chain ? ` → ${chain}` : ""} ──${_outcomeVerb(c.bid)}──▶ ${crossingEdge(c.bid)}`);
      } else if (sp.terminal === "frontier") {
        const chainNames = [qual(hunkById.get(cid)), ...downSteps.slice(1).map((s) => qual(_spineIdx.primaryHunk(s)))];
        spineLines.push(`  ● ${chainNames.join(" → ")} ⟂ [${sp.breakInfo?.mechanism ?? "opaque boundary"}]`);
      } else continue;   // no grounded culmination → stays the flat one-liner in ## Mechanisms
      // WAY-IN FAN (default ON; opt out with SEAM_SPINE_ENTRY=0) — EVERY distinct way in to this mechanism, each a
      // `← entry → ●` row. Two kinds, both enumerated (the engine never picks which flow matters — it lists them
      // all, deterministic + capped, and the agent chooses): (1) in-repo caller chains (entryFlowsOf), the UI
      // prepended across the route when the chain's ROOT is a route handler; (2) when the mechanism is ITSELF a
      // route handler (no in-repo caller — the concern centered on the REST layer), its cross-stack front-end(s)
      // ARE the way in (frontEndsOf on the mechanism). This is what links the front-end into the flow instead of
      // leaving it stranded in "## In". (Default differs from the single-anchor agent spine — see render/spine.ts.)
      if (process.env.SEAM_SPINE_ENTRY !== "0") {
        const flows = entryFlowsOf(cid);
        // each way in = an entry ROOT + the backend chain from it down to the mechanism ([] when the mechanism is
        // its own root). front-ends attach to the ROOT (or to the mechanism itself when it has no in-repo caller).
        const legs = flows.length ? flows.map((f) => ({ root: f[0], chain: f })) : [{ root: cid, chain: [] as string[] }];
        const rows: string[] = [];
        for (const { root, chain } of legs) {
          const chainNames = chain.map((id) => qual(hunkById.get(id)));
          const fes = frontEndsOf(root);
          if (fes.length) for (const fe of fes) {
            // UI ──HTTP route──▶ [backend chain →] ●  — when the chain is empty (the mechanism IS the route handler)
            // the UI crosses straight to ●, no trailing ` → `. QUALIFY the UI with its FILE: a front-end handler is a
            // bare, generic function name (`install`, `mounted`) that carries no class — meaningless without the file
            // (`install (bookingService.js)`) — so a reader/agent can open the right one.
            const feh = hunkById.get(fe.feId); const feBase = feh?.file ? String(feh.file).split("/").pop() : "";
            const uiName = feBase ? `${qual(feh)} (${feBase})` : qual(feh);
            const ui = `${uiName} ──${crossingEdge(fe.bid)}──▶`;
            rows.push(chainNames.length ? `      ← ${ui} ${chainNames.join(" → ")} → ●` : `      ← ${ui} ●`);
          } else if (chainNames.length) rows.push(`      ← ${chainNames.join(" → ")} → ●`);
        }
        const _entryCap = 6;
        const shown = [...new Set(rows)].slice(0, _entryCap);
        spineLines.push(...shown);
        if (rows.length > shown.length) spineLines.push(`      ← (+${rows.length - shown.length} more way(s) in — raise SEAM_CONCERN_ENTRIES)`);
        if (!rows.length) spineLines.push(`      ← (no in-repo caller and no cross-stack entry — a framework/DI-mounted or top-level entry)`);
      }
    }
    // The rolled-up "+K more" line is only meaningful once at least one mechanism actually SHOWED a spine — a
    // section that's ALL "(+N more … raise the cap)" with no path above it would be a misleading empty promise.
    if (spineLines.length) {
      const _spineRest = centerIds.length - _spineCenters.length;
      if (_spineRest > 0) spineLines.push(`  (+${_spineRest} more mechanism(s) not shown)`);
    }
  }
  if (spineLines.length) out.push("", "## Flows — every distinct way in to each mechanism (● = the mechanism; ← = a way in; the agent picks which to trace)", ...spineLines);
  // IN — who triggers the mechanism, each interaction THREADED through the boundary crossing it traverses
  // (entry ──HTTP /route──▶ ●), so the coupling edge is part of the flow, not a footnote. Deepen recipe stated ONCE.
  out.push("", `## In — what triggers ${dot}  (entry ──crossing──▶ ●)`);
  if (rayList.length) out.push(`  deepen any: seam --grow-from <file>#<symbol>${q}`);
  const shownRays = _es.topRays(cap);   // evidence-tiered pick (render/entry_surface.ts), co-access slice reserved
  for (const r of shownRays) out.push(entryRow(r));   // the SHARED row (render/entry_surface.ts)
  if (rayList.length > shownRays.length) out.push(`  (+${rayList.length - shownRays.length} more interaction(s) — raise SEAM_CONCERN_CAP)`);
  out.push(..._es.upstreamSection(shownRays));   // …and the callers behind them (monotonicity)
  // OUT — what the mechanism itself does: the boundaries it writes/reads (db table, queue), threaded as edges off ●.
  if (outCross.length) {
    // Name the mechanism side per row when the star has ≥2 mechanisms (a class fanned into its methods) — each
    // method's boundary is its own flow; for a single mechanism keep the compact `●`. Dedup on the rendered fact.
    const seenOut = new Set<string>();
    const outLines: string[] = [];
    for (const { mech, verb, bid } of outCross) {
      const lhs = mechCount > 1 ? qual(hunkById.get(mech)) : "●";
      const line = `  ${lhs} ──${verb}──▶ ${crossingEdge(bid)}`;
      if (seenOut.has(line)) continue; seenOut.add(line); outLines.push(line);
    }
    out.push("", `## Out — what ${dot} does  (● ──writes/reads──▶ boundary)`, ...outLines.sort());
  }
  // blindspots (reuse the fanout collapse idea, kept short)
  const bs = (model.blindspots ?? []) as any[];
  if (bs.length) { const keys = [...new Set(bs.map((b) => (b.candidates ?? [])[0]?.symbol ?? b.mechanism).filter(Boolean))];
    out.push("", `## Blindspots — ${bs.length} boundary/opaque site(s) over: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", …" : ""}`); }
  return out.join("\n");
}
