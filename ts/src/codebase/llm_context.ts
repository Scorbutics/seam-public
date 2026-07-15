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
import { type Hunk, type Seam, type Ranked, rolesOf, filesOf, _container, where, facts, lineageOf, memberLines, _shellOf, buildNodeIndex } from "./render/vocab.js";
export type { Hunk, Seam, Ranked };

// The 8 structural-shape renderers (consumers/deps/refactor/impact/compare/neighborhood/contract/reach)
// moved to render/shapes.ts — self-contained, no shared state with the flood/wave/agent/concern family below.
export { renderConsumerSet, renderDependencySet, renderRefactorFacts, renderImpact, renderComparison, renderNeighborhood, renderContract, renderReach } from "./render/shapes.js";

// The region/wave/scenario render family (renderLlmContext/renderWaves/renderScenarios + their shared
// _floodParents helper) moved to render/region_views.ts — self-contained aside from the vocab/medium_registry
// imports they (and the agent/concern renderers below) all share.
export { renderLlmContext, renderWaves, renderScenarios } from "./render/region_views.js";

// AGENT RENDER (Phase 3) — the ONE token-budgeted projection a coding agent reads instead of reconstructing a
// flow with a grep loop. Pure (reads only the emitted model, zero LLM, skeleton-compatible). Sections, in order:
// header · spine · region-by-tier · hubs · frontier · blindspots/unresolved. Everything a caller must TRUST —
// the spine, the collapsed hubs, the decision-point frontier, the honest gaps — is EXEMPT from budget cropping;
// only the off-path/supporting region lines (then hub sample-consumer detail) degrade, and WHAT was cropped is
// stated (I3). Reuses the same where/rolesOf/_WAVE_VERB vocabulary as the other views (one render language).
export function renderAgent(model: any, opts: { tokenBudget?: number; intent?: string } = {}): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  const budget = Math.max(300, opts.tokenBudget ?? 4000);
  const tok = (lines: string[]) => Math.ceil(lines.join("\n").length / 4);

  // id → label + the seam each node lives in (for reach phrases that stop at the seam boundary). Plus id → file /
  // start, so the spine can print the EXACT CALL SITE per hop (caller file:line) — the verify-by-glance the agent
  // trusts instead of re-grepping.
  const label = new Map<string, string>();
  const seamOfId = new Map<string, string>();
  const fileOfId = new Map<string, string>();
  const startOfId = new Map<string, number>();
  const kindOfId = new Map<string, string>();
  for (const s of seams) for (const h of (s.hunks ?? [])) { const id = (h as any).id; if (id != null) { const k = String(id); label.set(k, h.label ?? s.label); seamOfId.set(k, s.id); if (h.file) fileOfId.set(k, h.file); if (typeof h.start === "number") startOfId.set(k, h.start); if (h.kind) kindOfId.set(k, h.kind); } }
  const allIds = new Set(label.keys());
  const seamIds = (s: Seam) => new Set((s.hunks ?? []).map((h) => String((h as any).id)).filter((x) => x !== "undefined"));
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
  // (Defined here — before the spine — because the terminal-anchored spine BELOW keys on isBoundarySeam.)
  const primaryHunk = (s: Seam) => (s.hunks ?? []).find((h) => h.label === s.primary?.symbol && h.file === s.primary?.file) ?? (s.hunks ?? [])[0];
  const isBoundarySeam = (s: Seam) => _BOUND_KINDS.has((primaryHunk(s) as any)?.kind ?? "");
  const crossInto = (s: Seam): boolean => { const ids = seamIds(s); for (const e of (model.edges ?? []) as any[]) if (_CROSS_KINDS.has(e.kind) && ids.has(String(e.to)) && !ids.has(String(e.from)) && allIds.has(String(e.from))) return true; return false; };
  // "Other side" is a DIFFERENT language than the spine (Java backend ⇄ JS frontend) — the file EXTENSION is the
  // structural signal (the file's own type, not a name guess). A same-language self-route hop is NOT cross-stack.
  const _ext = (f?: string) => { const s = f ?? ""; const i = s.lastIndexOf("."); return i >= 0 ? s.slice(i + 1).toLowerCase() : ""; };

  // TERMINAL-ANCHORED SPINE (render projection — the emitted model stays flood-fill/region; the spine is a lens).
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
  const _terminalSpine = (): { path: Seam[]; alternates: Seam[]; grounded: boolean; terminal: "grounded" | "frontier" | "none"; breakInfo?: any; reachSet: Set<string> } => {
    const empty = { path: [] as Seam[], alternates: [] as Seam[], grounded: false, terminal: "none" as "grounded" | "frontier" | "none", reachSet: new Set<string>() };
    const anchorSeam = seamOfId.get(String(model.anchor));
    if (!anchorSeam) return empty;
    const anchorNode = String(model.anchor);   // the anchor NODE, not its (often god-class / merged-blob) seam
    const fwd = model.lead === "forward";   // consumers-lead footprint → the flow runs dst→src (mirror _seam_graph)
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    // A DATA-STORE boundary (a db-table / queue / cache / …) is TERMINAL in the spine: you write INTO it or read
    // FROM it, you don't flow THROUGH it. Fanning OUT of a store to its OTHER accessors reaches PEER entry points
    // (a table's co-writers / co-readers — surfaced in "Also writes"/"Also read"), NOT this flow's downstream. That
    // sideways fan is exactly how a hub table hijacks the spine: private-app `signUp` writes `members` (a 60-writer hub)
    // whose co-writer fan reaches the unrelated `payments` subsystem, so the walk crossed members→a co-writer→payments
    // and crowned payments. So NEVER traverse an edge whose flow-UPSTREAM end is a store node — the boundary is a
    // sink, not a through-node. Safe by construction for the DI case (keycloak createUser→UserEntity is reached by
    // writing INTO UserEntity, a code→store edge — kept; the store just doesn't fan further) and for cross-stack
    // (a route is a RELAY, not a _STORE kind, so route→consumer hops are untouched). (Opt out: SEAM_SPINE_STORE_TERMINAL=0.)
    const _storeTerminal = process.env.SEAM_SPINE_STORE_TERMINAL !== "0";
    const storeSeamIds = new Set<string>();   // seams holding a data-store boundary hunk — TERMINAL in the spine
    if (_storeTerminal) for (const s of seams) if ((s.hunks ?? []).some((h: any) => _STORE_KINDS.has(h.kind ?? ""))) storeSeamIds.add(s.id);
    const _trustGate = process.env.SEAM_SPINE_TRUST_GATE !== "0";
    for (const e of (model.edges ?? []) as any[]) {
      if (e.kind === "contains") continue;
      const srcN = fwd ? String(e.to) : String(e.from);   // the DOWNSTREAM-source node (fwd = consumers-lead → flow runs to→from)
      const dstN = fwd ? String(e.from) : String(e.to);
      const a = seamOfId.get(srcN), b = seamOfId.get(dstN);
      if (!a || !b || a === b) continue;
      // BLOB-SIBLING GUARD — the anchor seam is often a MERGED blob (private-app: `signUp` merged with a sibling `POST`
      // that reads `payments`). A blob sibling's boundary is NOT the anchor's outcome, yet expanding the whole seam
      // makes it one (the spine crowned `payments` via a one-hop `payments→POST` read off a co-member). So the anchor
      // seam expands ONLY via edges incident to the anchor NODE — its own flow — the same node-scoping directSink and
      // reachSeam already apply. Downstream (non-anchor) seams still expand at seam granularity.
      if (a === anchorSeam && srcN !== anchorNode) continue;
      link(a, b);   // DOWNSTREAM only: from the anchor OUT to its sinks, not back to callers
    }
    const dist = new Map<string, number>([[anchorSeam, 0]]); const prev = new Map<string, string>(); const q = [anchorSeam];
    // A data-store boundary is TERMINAL: once the flow reaches a table/queue it IS the outcome, so the BFS records it
    // (it stays a candidate sink) but never EXPANDS it. Expanding a store is precisely what fans the spine off a HUB
    // table to its PEER accessors (a table's other writers/readers — alternate entry points, not this flow's
    // downstream): private-app `signUp` writes the `members` hub, whose co-writers reach the unrelated `payments`, so the
    // walk crossed members→a co-writer→payments and crowned payments. Not-expanding stores cuts that fan while KEEPING
    // the store itself as the crowned sink. Safe: keycloak createUser→UserEntity is reached by writing INTO UserEntity
    // (UserEntity is the terminal, unexpanded — correct); a cross-stack route is a RELAY, not a store, so route→
    // consumer hops are untouched.
    while (q.length) {
      const c = q.shift()!; const d = dist.get(c)!;
      if (c !== anchorSeam && storeSeamIds.has(c)) continue;   // reached a store → terminal, don't traverse THROUGH it
      for (const nb of adj.get(c) ?? []) if (!dist.has(nb)) { dist.set(nb, d + 1); prev.set(nb, c); q.push(nb); }
    }
    const byId = new Map(seams.map((s) => [s.id, s]));
    // candidate SINKS = the reachable DOWNSTREAM grounded boundaries. region.direction is the emit's authoritative
    // up/down classification: a "down" boundary is a dependency/SINK the flow produces into (a db-write target); an
    // "up" boundary is an inbound CALLER route — the entry, never the outcome. Requiring "down" stops an upstream
    // caller-route (reachable through a crossing whose edge direction doesn't track the call direction) from being
    // crowned the sink. Default "down" so models that omit direction aren't excluded (the hand-built render tests).
    // STRUCTURE picks the PRIMARY among the sinks — the agent-facing basis is EMBEDDING-FREE and LLM-FREE (the
    // consuming agent does the semantic "which one does the intent mean" itself; a fuzzy cosine here just gets it
    // WRONG — it rated cal `bookingSeat` 0.354 > `booking` 0.318, crowning the child detail table for "a booking
    // is created"). So rank by GROUNDED STRUCTURE only: directSink → providerWrite → depth → WRITE-ORDER within
    // the same file → weight → stable id. WRITE-ORDER is the create-genesis prior: an FK child (bookingSeat) can
    // only be persisted AFTER its parent row (booking) exists, so among same-file same-tier own-writes the EARLIER
    // line is the root entity the flow is named for. (Cross-file this term is inert — line numbers aren't
    // comparable across files.) The non-crowned sinks are ALTERNATES (also-reaches), one glance away, never hidden.
    const _line = (s: Seam) => (typeof (s as any).primary?.line === "number" ? (s as any).primary.line : 1e9);
    const _sameFile = (a: Seam, b: Seam) => !!a.primary?.file && a.primary?.file === b.primary?.file;
    const writeOrder = (a: Seam, b: Seam) => (_sameFile(a, b) ? (_line(a) - _line(b)) : 0);
    // A DATA-STORE boundary (db-table / queue / cache / topic / file) is inherently TERMINAL — you don't "call
    // downstream" into a table, you SHARE it, so a shared-key coupling to it is a sink whatever its region
    // direction. A RELAY boundary (route) can be an upstream CALLER or a downstream handler, so it must be
    // direction "down" to count as an outcome (else an inbound caller-route gets crowned — the booking case).
    const isStoreSink = (s: Seam) => _STORE_KINDS.has((primaryHunk(s) as any)?.kind ?? "");
    // STRUCTURAL PRIOR — a sink the ANCHOR writes DIRECTLY (a produce/write edge FROM an anchor-seam node) is what
    // THIS operation persists: a grounded fact that outranks a weak name-embedding. On Keycloak the embedding rates
    // the token-rich but PERIPHERAL `UserVerifiableCredentialEntity` (0.346) over the plain, CENTRAL `UserEntity`
    // (0.158) that addUser's own `em.persist` writes — the direct-write prior corrects it. CLAUDE.md in motion:
    // STRUCTURE names the fact (the anchor writes this table), embeddings only order the REST (the also-reaches).
    const _PRODUCE = new Set(["db-write", "service-write", "produce", "write", "save", "persist", "insert"]);
    const _CALL = new Set(["call", "invokes", "dispatch"]);   // control-flow delegation edges
    const _DELEGATE = new Set([..._CALL, "interface-impl", "provider-impl", "reference"]);
    const _TYPEREF = new Set(["interface", "type", "enum", "type-alias", "type-ref", "file-ref"]);   // not execution steps
    const edges = (model.edges ?? []) as any[];
    // DOWNSTREAM CALL CLOSURE — the anchor's transitive delegation reach over CALL/DELEGATE edges (bounded depth),
    // so a culmination written 2+ hops deep becomes a candidate: keycloak `createUser→profile.create→addUser→
    // UserEntity` and private-app `runPhaseEnrich→provisionOrUpdateMember→applyMemberSubscription→…→members` are BOTH the
    // real outcome yet TWO+ hops past the anchor — the old one-hop delegate borrow missed them, so the spine fell to
    // an embedding-nearest FRINGE write (UserVerifiableCredentialEntity) or the anchor's own bookkeeping write
    // (payments state). The closure follows CALLS ONLY (a resolved `import` carrying a use-line is a call; TYPE/FILE
    // refs and the sideways store-fan are NOT) and is bounded (SEAM_SPINE_CLOSURE_DEPTH, default 5) so an
    // orchestrator's subtree can't flood back in. Purely STRUCTURAL (resolved edges) — intent-free, per CLAUDE.md.
    const _closureMax = Math.max(1, parseInt(process.env.SEAM_SPINE_CLOSURE_DEPTH ?? "5", 10) || 5);
    const _delegateMax = Math.max(1, parseInt(process.env.SEAM_SPINE_DELEGATE_HOPS ?? "3", 10) || 3);   // pure-delegate borrow: hops to follow through pass-throughs to the first writer
    const callDepth = new Map<string, number>([[anchorNode, 0]]);
    for (const q = [anchorNode]; q.length; ) {
      const c = q.shift()!; const d = callDepth.get(c)!;
      if (d >= _closureMax) continue;
      for (const e of edges) {
        if (String(e.from) !== c) continue;
        const isCall = _DELEGATE.has(e.kind) || (e.kind === "import" && Number(e.line) > 0);
        if (!isCall) continue;
        const to = String(e.to);
        if (!label.has(to) || _TYPEREF.has(kindOfId.get(to) ?? "") || callDepth.has(to)) continue;   // resolved, non-type, unseen
        callDepth.set(to, d + 1); q.push(to);
      }
    }
    // ownIds = the anchor's OWN in-body writes (depth 0), trusted unconditionally. directIds = the crown PRIOR: the
    // anchor's own write, or — for a pure pass-through that writes nothing itself — the ONE-HOP delegate's write (a
    // controller persists THROUGH its sole delegate). This precedence is load-bearing: the anchor's own/near write
    // must WIN the crown over a DEEPER peripheral write even when the embedding rates the peripheral one higher
    // (addUser→UserEntity beats a deeper audit→AuditEntity; the direct-write prior corrects the misleading embedding).
    const ownIds = new Set<string>();
    for (const e of edges) if (_PRODUCE.has(e.kind) && String(e.from) === anchorNode) ownIds.add(String(e.to));
    const directIds = new Set<string>(ownIds);
    if (!ownIds.size) {
      // PURE-DELEGATE borrow: no own write → follow the anchor's delegate calls, SKIPPING pure pass-through hops (a
      // callee that writes NOTHING itself) until the FIRST WRITER on each branch, and borrow that write. A handler
      // that persists THROUGH `roleMapper.grantRole` → (impl) → `grantRoleImpl` → em.persist reaches the write TWO
      // hops down; the old one-hop borrow missed it, so a polymorphic SIBLING that writes IN-BODY
      // (GroupAdapter.grantRole → GroupRoleMappingEntity, one hop) out-ranked it on the directSink prior even though
      // the intent (a USER role mapping) prefers the user side. Halting at the FIRST writer keeps this from flooding a
      // subtree — a delegate that DOES write (svc → UserEntity) stops the walk, so its own deeper audit call is NOT
      // borrowed (the delegating-anchor prior is preserved). Both sibling outcomes become directSinks → RELEVANCE
      // then picks the intended impl (structure enumerates the candidates, the embedding judges which the intent means).
      const producer = new Set<string>();
      for (const e of edges) if (_PRODUCE.has(e.kind)) producer.add(String(e.from));
      const seen = new Set<string>([anchorNode]);
      let frontier = new Set<string>();
      for (const e of edges) if (_DELEGATE.has(e.kind) && String(e.from) === anchorNode) frontier.add(String(e.to));
      for (let hop = 0; hop < _delegateMax && frontier.size; hop++) {
        const next = new Set<string>();
        for (const c of frontier) {
          if (seen.has(c)) continue; seen.add(c);
          if (producer.has(c)) { for (const e of edges) if (_PRODUCE.has(e.kind) && String(e.from) === c) directIds.add(String(e.to)); }   // a WRITER → borrow + halt this branch
          else for (const e of edges) if (_DELEGATE.has(e.kind) && String(e.from) === c) next.add(String(e.to));   // pure pass-through → follow one more hop
        }
        frontier = next;
      }
    }
    // chainIds = grounded writes DEEPER on the call closure, PAST the one-hop prior (private-app `members`, written by
    // provisionOrUpdateMember→…→findMemberId, 2+ hops from runPhaseEnrich; the real tier culmination). ADMITTED as
    // candidate sinks so the culmination SURFACES (as an alternate under the spine) — the old one-hop scoping never
    // admitted it, so it fell into the blindspots. NOT a directSink: the crown prior above still wins, so a deep
    // PERIPHERAL write (audit) can't hijack the spine from the anchor's own outcome — it just becomes an alternate.
    const chainIds = new Set<string>();
    for (const e of edges) if (_PRODUCE.has(e.kind) && callDepth.has(String(e.from)) && !directIds.has(String(e.to))) chainIds.add(String(e.to));
    const directSink = (s: Seam) => (s.hunks ?? []).some((h: any) => directIds.has(String(h.id)));
    const ownSink = (s: Seam) => (s.hunks ?? []).some((h: any) => ownIds.has(String(h.id)));
    // A grounded ANCHOR WRITE (directSink) is a candidate EVEN when the BFS didn't reach it: in `fwd` (consumers-lead)
    // footprints the anchor's own `db-write` edge (n1→table) is stored/traversed as table→n1, so the table it persists
    // is unreachable DOWNSTREAM and `dist` misses it — yet the anchor demonstrably writes it (a direction-agnostic
    // grounded fact). Without this, an anchor that writes its subject IN ITS OWN FILE (cal.com createTeamsHandler →
    // `team`) has ZERO candidates and the spine falls to the off-subject tier band. directSink also bypasses the
    // store/down gate (a write IS an outcome) and the dist-distance sort term (default it to 1, an anchor-adjacent hop).
    const _dist = (id: string) => (dist.has(id) ? dist.get(id)! : 1);
    // PROVIDER-WRITE — a store written by a node bound through the DI PROVIDER-FACTORY hop (a `provider-impl` edge:
    // JpaRealmProvider, the GroupProvider impl `session.groups()` returns) is the CREATE path's persist. An entity
    // written by a co-bound ENTITY ADAPTER (GroupAdapter, a GroupModel `@Inject` binding) is a post-create mutation
    // (role-mappings/attributes). When both persist and tie as directSinks, the provider write is the outcome — the
    // structural signal that the embedding misses (it rates the compound `GroupRoleMappingEntity` over `GroupEntity`).
    const _providerTargets = new Set<string>();
    for (const e of edges) if (e.kind === "provider-impl") _providerTargets.add(String(e.to));
    const providerWrite = (s: Seam): boolean => (s.hunks ?? []).some((h: any) =>
      edges.some((e) => _PRODUCE.has(e.kind) && String(e.to) === String(h.id) && _providerTargets.has(String(e.from))));
    // TRUST GATE — reject a directSink that is a COUPLING OVER-ATTRIBUTION, not a real persist. A GETTER whose
    // node-range bled over a sibling's writes (keycloak isValid → `getUsername`, credited with db-writes to FOUR
    // user tables it never persists — UserAttribute/UserGroupMembership/UserRequiredAction/UserRoleMapping) crowns a
    // confident-wrong terminal (the same `UserRoleMappingEntity` is right for "roles" yet wrong for "credentials" —
    // intent-blind coupling). The signature is a SINGLE non-provider writer credited with ≥K distinct store writes —
    // a real method persists a FOCUSED aggregate; a class-wide bleed writes many unrelated tables. So a borrowed
    // write is TRUSTED when it's the anchor's OWN write, a DI PROVIDER write, or written by a FOCUSED writer
    // (< K stores) — the legit delegate borrow (a handler → interface-impl/call → an impl that persists ONE entity)
    // survives; only the many-table bleed is demoted (it stays in "Also writes"). (Tune: SEAM_SPINE_OVERATTRIB_K.)
    const _overAttribK = Math.max(2, parseInt(process.env.SEAM_SPINE_OVERATTRIB_K ?? "3", 10) || 3);
    const writesOf = new Map<string, Set<string>>();   // writer node → the distinct store tables it is credited writing
    for (const e of edges) if (_PRODUCE.has(e.kind)) {   // PRODUCE targets ARE store boundaries — count distinct table labels
      const tbl = label.get(String(e.to)) ?? String(e.to);
      (writesOf.get(String(e.from)) ?? writesOf.set(String(e.from), new Set()).get(String(e.from))!).add(tbl);
    }
    // a store hunk is written by a FOCUSED (non-bleed) writer that isn't a DI provider (providers legitimately front
    // many tables — they're gated by `providerWrite` instead)
    const focusedWriter = (s: Seam): boolean => (s.hunks ?? []).some((h: any) => edges.some((e) =>
      _PRODUCE.has(e.kind) && String(e.to) === String(h.id) && !_providerTargets.has(String(e.from))
      && (writesOf.get(String(e.from))?.size ?? 0) < _overAttribK));
    const trustedDirect = (s: Seam) => directSink(s) && (!_trustGate || ownSink(s) || providerWrite(s) || focusedWriter(s));
    // A DEEP-closure write (chainIds) is ADMITTED as a candidate sink (so the real culmination surfaces as an
    // alternate) under the SAME trust gate as a borrowed direct write (a provider or a focused writer — never a
    // class-wide bleed). It is NOT a directSink, so the crown prior above still wins: the deep write is an alternate,
    // never the crown, unless nothing nearer grounds. This is the "deepen ADMISSION, preserve PRECEDENCE" split.
    const chainSink = (s: Seam) => (s.hunks ?? []).some((h: any) => chainIds.has(String(h.id)));
    const trustedChain = (s: Seam) => chainSink(s) && (!_trustGate || providerWrite(s) || focusedWriter(s));
    // SUBJECT-CONTINUITY (structural, no embedding) — the flow's SUBJECT tables are those the anchor's OWN MODULE
    // (its directory) touches. A grounded sink whose table is OFF the subject (a side-effect that lives in another
    // module — `bug_reports` on a payments flow) must NOT out-crown an on-subject sink just because it sorts earlier
    // by stable id. This is the structural signal that REPLACES the embedding's old "keep the crown on-subject" role.
    // Module-based (NOT anchor-own-writes — the anchor may also write a side table), gated by SEAM_SUBJECT_DIM.
    const _tblOf = (s: Seam) => String((primaryHunk(s) as any)?.label ?? "");
    const _anchorDir = (fileOfId.get(anchorNode) ?? "").replace(/\/[^/]*$/, "");
    const _moduleTbls = new Set<string>();
    for (const s of seams) { const f = s.primary?.file; if (f && _anchorDir && f.startsWith(_anchorDir + "/") && isBoundarySeam(s)) { const t = _tblOf(s); if (t) _moduleTbls.add(t); } }
    const _onSubject = (s: Seam) => process.env.SEAM_SUBJECT_DIM === "0" || !_tblOf(s) || _moduleTbls.has(_tblOf(s));
    // SINK RANK — a real DATA-STORE persistence (db-table/queue/cache/topic/file: a PERSISTED row) is the culmination
    // (rank 2); a shared SERVICE-STATE handle (kind `service` — keycloak `session`, runtime state passed between
    // beans, NOT a persisted row, but still in STORE_KINDS) is plumbing (rank 1) and must never out-crown a real
    // persistence; a non-store boundary is rank 0. Ranked FIRST, so `UserRoleMappingEntity` (db-table) beats a
    // `session` service-state crossing even when the session sorts earlier by id. Then the own-write/provider/
    // subject/depth/write-order tiers break ties AMONG equal-rank sinks.
    const _sinkRank = (s: Seam) => { const k = String((primaryHunk(s) as any)?.kind ?? ""); return (_STORE_KINDS.has(k) && k !== "service") ? 2 : k === "service" ? 1 : 0; };
    // HUB-CROSSING EXCLUSION — a shared-key CROSSING (proposedBy "crossing") to a HUB table (a coincidental common
    // key the footprint merely touches — keycloak `clients` read in 26 files, `session` in 750, flagged by a
    // `shared-key-fanout` blindspot) is NOT the flow's culmination. It out-ranked the real call-graph-resolved
    // `UserRoleMappingEntity` write and, when that write dropped from the (non-deterministic) footprint, confidently
    // crowned `clients` — an unrelated import/export path. NEVER crown a hub crossing: the spine then crowns a REAL
    // write if one exists, else falls to an honest inferred/frontier terminus (a coincidental hub bleed is worse than
    // "no grounded boundary"). A NON-hub crossing (a specific shared key — the co-producer / data-flow rung) is kept.
    const _hubTables = new Set<string>();
    for (const b of (model.blindspots ?? []) as any[]) if (b.mechanism === "shared-key-fanout") { const t = String(b.evidence ?? "").match(/'([^']+)'/)?.[1]; if (t) _hubTables.add(t); }
    const _isHubCrossing = (s: Seam) => (s as any).proposedBy === "crossing" && _hubTables.has(_tblOf(s));
    const cands = seams.filter((s) => isBoundarySeam(s) && s.id !== anchorSeam && !_isHubCrossing(s)
        && (dist.has(s.id) || trustedDirect(s) || trustedChain(s))
        && (isStoreSink(s) || trustedDirect(s) || trustedChain(s) || ((s as any).region?.direction ?? "down") === "down"))
      .sort((a, b) => (_sinkRank(b) - _sinkRank(a)) || (Number(directSink(b)) - Number(directSink(a))) || (Number(providerWrite(b)) - Number(providerWrite(a))) || (Number(_onSubject(b)) - Number(_onSubject(a))) || (_dist(b.id) - _dist(a.id)) || writeOrder(a, b) || (((b as any).hunks?.length ?? 0) - ((a as any).hunks?.length ?? 0)) || (a.id < b.id ? -1 : 1));
    // Path from the anchor to a sink. A directSink the BFS never reached (its write edge was reversed by fwd) has no
    // `prev` chain → render it as the direct 1-hop `anchor → sink`.
    const pathTo = (toId: string): string[] => {
      if (toId !== anchorSeam && !prev.has(toId)) return [anchorSeam, toId];
      const p: string[] = []; for (let cur: string | undefined = toId; cur; cur = prev.get(cur)) { p.unshift(cur); if (cur === anchorSeam) break; } return p;
    };
    // (b) DEFER A WEAK CROWN TO AN HONEST DI WALL — when the best grounded candidate is only a SERVICE-STATE crossing
    // or a non-store (sink-rank < 2, NOT a real persistence) AND the flow's real persist is behind a DI wall (an
    // interface-multiple-impls blindspot whose impls DO persist — `persists`), crowning the plumbing is MISLEADING
    // (keycloak createUser reaches `session` service-state; the em.persist(UserEntity) is behind the UserProvider DI
    // binding, two facades deep). Terminate at the wall and demote the weak sinks to "Also reaches". A real db-store
    // crown (rank 2) is NEVER deferred; and it only fires when such a persisting wall actually exists in the footprint.
    const _bestRank = cands.length ? _sinkRank(cands[0]) : -1;
    const _persistWall = ((model.blindspots ?? []) as any[]).find((b) => b.mechanism === "interface-multiple-impls" && b.persists);
    const _deferWeak = cands.length > 0 && _bestRank < 2 && !!_persistWall;
    if (!cands.length || _deferWeak) {
      // FRONTIER-⟂ TERMINAL — no (crownable) grounded sink, but the flow provably continues DOWNSTREAM into an OPAQUE
      // node the grow COULD NOT follow (a runtime-DI multi-impl, an unresolved import, a string dispatch). Terminate
      // the spine THERE, honestly — naming the break + the candidate set — instead of a smooth wrong crown (trust rule).
      const OPAQUE = new Set(["interface-multiple-impls", "unresolved-import", "string-dispatch", "dynamic-dispatch", "dynamic-import"]);
      const bsByNode = new Map<string, any>();
      for (const b of (model.blindspots ?? []) as any[]) if (OPAQUE.has(b.mechanism)) bsByNode.set(String(b.node), b);
      // weak grounded sinks (session) are still REACHED — demote them to alternates so they surface in "Also reaches".
      const _alts: Seam[] = []; { const seen = new Set<string>(); for (const s of cands) { const k = `${s.primary?.file}#${s.primary?.symbol}`; if (seen.has(k)) continue; seen.add(k); _alts.push(s); } }
      // prefer the PERSISTING DI wall as the break target (the real persist is behind it), whether we had no grounded
      // sink at all or only a weak service-state one; else the deepest reachable opaque stop (dynamic import, etc.).
      const wallNode = _persistWall ? String(_persistWall.node) : null;
      // a reachable seam that IS the wall — matched by its hunk id OR (a DI interface node) its symbol/label
      const isWallSeam = (s: Seam) => (s.hunks ?? []).some((h: any) => bsByNode.has(String(h.id)))
        || (!!wallNode && (s.primary?.symbol === wallNode || (s.hunks ?? []).some((h: any) => h.label === wallNode)));
      if (bsByNode.size) {
        const stops = seams.filter((s) => dist.has(s.id) && s.id !== anchorSeam && isWallSeam(s))
          .sort((a, b) => (dist.get(b.id)! - dist.get(a.id)!) || (a.id < b.id ? -1 : 1));
        if (stops.length) {
          const ids = pathTo(stops[0].id);
          const bs = _persistWall ?? ((stops[0].hunks ?? []).map((h: any) => bsByNode.get(String(h.id))).find(Boolean));
          return { path: ids.map((id) => byId.get(id)!).filter(Boolean), alternates: _deferWeak ? _alts : [], grounded: false, terminal: "frontier", breakInfo: bs, reachSet: new Set(dist.keys()) };
        }
      }
      // no reachable wall SEAM (the interface node itself isn't in the footprint), but we KNOW the persisting wall —
      // terminate at the anchor and disclose it, rather than crowning the plumbing sink (or saying "no boundary").
      if (_persistWall) {
        const aSeam = byId.get(anchorSeam);
        return { path: aSeam ? [aSeam] : [], alternates: _alts, grounded: false, terminal: "frontier", breakInfo: _persistWall, reachSet: new Set(dist.keys()) };
      }
      return { ...empty, reachSet: new Set(dist.keys()) };
    }
    const pathIds = pathTo(cands[0].id);
    const path = pathIds.map((id) => byId.get(id)!).filter(Boolean);
    // ALSO REACHES — the OTHER downstream sinks the intent didn't crown (deduped by symbol, off-path only). A wrong
    // primary pick is then one glance from correction (repoint --intent), never a silently-buried terminal.
    const onPath = new Set(pathIds); const seen = new Set<string>(); const alternates: Seam[] = [];
    for (const s of cands.slice(1)) { if (onPath.has(s.id)) continue; const k = `${s.primary?.file}#${s.primary?.symbol}`; if (seen.has(k)) continue; seen.add(k); alternates.push(s); }
    return { path, alternates, grounded: true, terminal: "grounded", reachSet: new Set(dist.keys()) };
  };
  const _spine = _terminalSpine();
  const spineGrounded = _spine.grounded;
  const spineTerminal = _spine.terminal;
  const spineBreak = _spine.breakInfo;
  // TIER-BAND FALLBACK (no grounded/frontier terminal) — the emit's `tier==="spine"` band is a RELEVANCE ranking,
  // not a flow, so it drifts to embedding-adjacent seams that are NOT on the anchor's resolved path (private-app signIn →
  // `signUp`, a file-adjacent sibling it never calls; cal's :0-bound anchor → PayPal). When the anchor seam RESOLVED
  // (reachSet non-empty), keep only band seams STRUCTURALLY reachable from it — the anchor's real downstream flow —
  // dropping the drift. When the anchor didn't resolve to a seam (reachSet empty — a hand-built model whose anchor id
  // isn't a hunk, or a fully-opaque center) we can't compute flow, so trust the emit's band as-is. (SEAM_SPINE_TRUST_GATE=0 opts out.)
  const spineSeams = _spine.path.length ? _spine.path
    : (process.env.SEAM_SPINE_TRUST_GATE !== "0" && _spine.reachSet.size
        ? seams.filter((s) => tierOf(s) === "spine" && _spine.reachSet.has(s.id))
        : seams.filter((s) => tierOf(s) === "spine"));
  const spineSet = new Set(spineSeams.map((s) => s.id));
  const spineAlternates = _spine.alternates;
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
  const _mechDepth = Math.max(1, parseInt(process.env.SEAM_MECHANISM_DEPTH ?? "3", 10) || 3);
  const _PRODUCE_MECH = new Set(["db-write", "service-write", "produce", "write", "save", "persist", "insert", "db-read", "service-read", "consume", "read"]);
  const pipeline: { id: string; line: number; depth: number; sink?: string }[] = [];
  if (_mechOn) {
    const anchorNode = String(model.anchor);
    const edges = (model.edges ?? []) as any[];
    const dep = new Map<string, number>([[anchorNode, 0]]);
    const callLine = new Map<string, number>();   // the call-site line of the FIRST edge that reached each step
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
        dep.set(to, d + 1); callLine.set(to, Number(e.line) > 0 ? Number(e.line) : 0); q.push(to);
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
      .map((id) => ({ id, line: callLine.get(id) ?? 0, depth: dep.get(id)!, sink: sinkOf(id) }));
    // FLOW ORDER — the anchor's operations in EXECUTION order (depth, then call-site line): the sequence a reader
    // reconstructs the flow from (validated by the eval — every BETTER verdict praised the call-order). NB: an
    // outcome-first sort was tried and REVERTED — it hoisted grounded-sink ops but pushed the key delegation
    // (private-app provisionOrUpdateMember, no DIRECT sink) below the budget cap, and cal's late side-effects stay hidden
    // regardless because they are UNGROUNDED (a grounding/attribution gap, not an ordering one).
    entries.sort((a, b) => (a.depth - b.depth) || (a.line - b.line) || (a.id < b.id ? -1 : 1));
    pipeline.push(...entries);
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
    h.push(`resolution: ${model.resolutionQuality ?? "?"}`,
      `seams: ${seams.length - _crossSeams} grounded${_crossSeams ? ` + ${_crossSeams} shared-key crossing(s)` : ""}`,
      `unresolved: ${(model.unresolved ?? []).length}`,
      `blindspots: ${_bsAll.length - _fanoutBs} actionable${_fanoutBs ? ` (+ ${_fanoutBs} folded hub table(s))` : ""}`);
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
    return `${q} (${f}:${startOfId.get(a) ?? 0})`;
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
    const site = `${fileOfId.get(f) ?? "?"}:${best.line || startOfId.get(f) || "?"}`;
    return `${site} ──${best.kind}──▶ ${label.get(String(best.to)) ?? "?"}`;
  };
  // SPINE — three honest states, never a confident-but-wrong path (the trust rule): (a) GROUNDED — the anchor→sink
  // path terminating at a real boundary (db/route/queue); (b) INFERRED — no boundary was reached, so the tier band
  // is shown but LABELLED as inferred, never presented as a proven flow; (c) NONE — under an intent, an anchor that
  // reaches no downstream boundary says so (a leaf / policy / wrong center), instead of banding a fake spine.
  const spineSection = (): string[] => {
    if (!hasSpine) {
      if (!opts.intent) return [];   // no intent → no flow question → stay silent (region-by-shell speaks for itself)
      return ["", "## Spine — none: this anchor reaches no grounded boundary (db-table / route / queue) downstream.",
        "  The flow may not terminate here (a leaf / a policy or compute concern), or the center/intent is off — read the region below."];
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
    const uniq = [...coProducers].sort(byRelDesc).filter((s) => { const k = where(s); if (seen.has(k)) return false; seen.add(k); return true; });
    return ["", "## Also writes (other producers of this flow's data — alternate entry points a call-trace misses)",
      ...renderCapped(uniq, EXEMPT_N, (s) => seamLine(s), "producer(s)")];
  };
  // ALSO READ — the OTHER files that read the subject table (the display/consume side): admin lists, the member
  // invoice page. Exempt from the region crop so the "…and where is it displayed" half isn't lost to a hub label.
  const alsoReadSection = (): string[] => {
    if (!readers.length) return [];
    const seen = new Set<string>();
    const uniq = [...readers].sort(byRelDesc).filter((s) => { const k = where(s); if (seen.has(k)) return false; seen.add(k); return true; });
    return ["", "## Also read (where this flow's data is consumed — the display/read side)",
      ...renderCapped(uniq, EXEMPT_N, (s) => seamLine(s), "consumer(s)")];
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
  const pipelineSection = (): string[] => {
    if (!showPipeline) return [];
    return ["", "## Mechanism (the anchor's downstream operations, in call order — ` ──▶ sink` = what a step persists/reads; ` ⟂` = the flow continues into a runtime-chosen impl)",
      ...renderCapped(pipeline, EXEMPT_N, (p, i) => {
        const f = fileOfId.get(p.id), where2 = f ? ` (${f}:${startOfId.get(p.id) ?? 0})` : "";
        const dyn = _dynDispatch.get(p.id);
        return `  ${i + 1}. ${label.get(p.id) ?? "?"}${where2}${p.sink ? ` ──▶ ${p.sink}` : ""}${dyn ? ` ⟂ ${dyn}` : ""}${_anchorFileBase && p.line ? `   [called at ${_anchorFileBase}:${p.line}]` : ""}`;
      }, "step(s)")];
  };
  // CROSS-STACK — the promoted other-side-of-the-boundary code seams, deduped by symbol + capped. Placed right
  // after the spine (not in the region) so the shared-key link a grep can't follow is PROMINENT, per the ask.
  const crossStackSection = (): string[] => {
    if (!crossStack.length) return [];
    const seen = new Set<string>();
    const uniq = [...crossStack].sort(byRel).filter((s) => { const k = where(s); if (seen.has(k)) return false; seen.add(k); return true; });
    return ["", "## Cross-stack (the OTHER side of a shared-key boundary — grep can't link these)",
      ...renderCapped(uniq, EXEMPT_N, (s) => seamLine(s), "cross-stack node(s)")];
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
    if (!hasSpine) {   // no-intent / skeleton fallback: order every seam by shell (hops from the anchor)
      [...seams].sort((a, b) => (_shellOf(a) - _shellOf(b))).forEach((s) => out.push(seamLine(s)));
      return out;
    }
    // DEDUP by symbol identity — a hub the grow reached by N paths (or a bean wired into N seams that escaped the
    // hub collapse) otherwise renders the SAME `where()` line N times (Acme: BookingsBean 4× in supporting), pure
    // noise. Keep the highest-relevance occurrence (the list is pre-sorted by relevance). Then crop.
    const dedup = (list: Seam[]): Seam[] => { const seen = new Set<string>(); return list.filter((s) => { const k = where(s); if (seen.has(k)) return false; seen.add(k); return true; }); };
    // HUB-TABLE COLLAPSE — a shared-key HUB (a table like `user`/`workflowStep` touched by dozens of files) surfaces
    // as one region seam PER file, flooding the region and burying the on-intent code (cal.com: `user`×24, `team`×20).
    // Those crossings are ALREADY rolled up in the shared-key-fanout Blindspot, so keep ONE occurrence per hub label
    // and fold the rest into a single pointer line. Gated on a label carried by ≥K region seams — real code almost
    // never repeats a label that many times across distinct files, so it's the hub fan (opt out: SEAM_REGION_HUB_COLLAPSE=0).
    const _HUB_K = Math.max(3, parseInt(process.env.SEAM_REGION_HUB_K ?? "6", 10) || 6);
    const _hubCollapse = process.env.SEAM_REGION_HUB_COLLAPSE !== "0";
    const collapseHubs = (list: Seam[]): { kept: Seam[]; hubs: Map<string, number> } => {
      if (!_hubCollapse) return { kept: list, hubs: new Map() };
      const cnt = new Map<string, number>();
      for (const s of list) { const l = s.label ?? ""; if (l) cnt.set(l, (cnt.get(l) ?? 0) + 1); }
      const kept: Seam[] = [], hubs = new Map<string, number>(), seen = new Set<string>();
      for (const s of list) {
        const l = s.label ?? "";
        if (l && (cnt.get(l) ?? 0) >= _HUB_K) { if (seen.has(l)) { hubs.set(l, (hubs.get(l) ?? 0) + 1); continue; } seen.add(l); }   // keep the 1st (top-relevance), roll up the rest
        kept.push(s);
      }
      return { kept, hubs };
    };
    const rankedRegion = (list: Seam[], label: string, drop: boolean, headN: number): void => {
      if (!list.length) return;
      const { kept: sorted, hubs } = collapseHubs(dedup([...list].sort(byRel)));
      const rollup = (): void => { if (!hubs.size) return; const tot = [...hubs.values()].reduce((a, b) => a + b, 0);
        out.push(`  (+${tot} more file(s) folded as shared-key hub crossings over: ${[...hubs.keys()].slice(0, 12).join(", ")}${hubs.size > 12 ? ", …" : ""} — see Blindspots)`); };
      if (!drop || sorted.length <= headN) { out.push(`${label}:`); sorted.forEach((s) => out.push(seamLine(s))); rollup(); return; }
      out.push(`${label} (top ${headN} of ${sorted.length} by intent relevance — raise --token-budget for the rest):`);
      sorted.slice(0, headN).forEach((s) => out.push(seamLine(s))); rollup();
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

  // ---- assemble; degrade OFF → supporting → hub samples, never the exempt sections (I3) ----
  const assemble = (dropOff: boolean, dropSupporting: boolean, dropSamples: boolean): string[] =>
    [...header(), ...spineSection(), ...pipelineSection(), ...alsoReachesSection(), ...alsoWritesSection(), ...alsoReadSection(), ...crossStackSection(), ...regionSection(dropOff, dropSupporting), ...hubsSection(dropSamples), ...frontierSection(), ...gapsSection()];
  const steps: [boolean, boolean, boolean][] = [[false, false, false], [true, false, false], [true, true, false], [true, true, true]];
  let out: string[] = [];
  for (const step of steps) { out = assemble(...step); if (tok(out) <= budget) break; }   // first fitting crop level, else the most-cropped
  return out.join("\n");
}

// CONCERN RENDER (prototype) — a CENTER-first projection for plural "how is X managed?" questions, where the
// answer is a STAR (a shared mechanism + the interactions around it) not a linear flow. The center is found
// STRUCTURALLY: the node with the highest fan-in (most consumers) in the intent-region — on Acme, the
// `BookingsBean` every interaction delegates through. Its consumers (each walked up to its entry point) are the
// INTERACTIONS, ranked by intent tier. Pure projection of an already-grown model (no re-grow) — validates whether
// the star FRAMING reads better than the flow map on a concern; the full plan re-anchors the grow on the center.
// NOTE: unlike renderAgent, this view crops by 3 independent env-tunable caps (SEAM_CONCERN_CAP/_VIAS/_OPS)
// rather than a token budget — there is no `opts.tokenBudget` here (a prior version declared but never read
// one; if real token-budget cropping is wanted for this view, it needs its own degrade loop, not a bare flag).
export function renderConcern(model: any, opts: { intent?: string; centers?: { file: string; symbol: string }[] } = {}): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  const _nodeIndex = buildNodeIndex(seams);
  const hunkById = new Map<string, any>([..._nodeIndex].map(([k, v]) => [k, v.hunk]));
  const seamOf = new Map<string, Seam>([..._nodeIndex].map(([k, v]) => [k, v.seam]));
  const edges = (model.edges ?? []) as any[];
  // fan-in (consumers) ignoring containment. `callIn` = only CALL/reference/import in-edges (NOT crossings) — the
  // entry walk climbs those, so a data-READ edge (boundary → reader) is never mistaken for a caller (which would
  // climb a coupling interaction UP into the boundary node).
  const inEdges = new Map<string, Set<string>>();     // node → all its consumers (for center fan-in)
  const callIn = new Map<string, Set<string>>();      // node → its CALL-graph callers only (for the entry walk)
  for (const e of edges) { if (e.kind === "contains") continue; const f = String(e.from), t = String(e.to);
    (inEdges.get(t) ?? inEdges.set(t, new Set()).get(t)!).add(f);
    if (!_CROSS_KINDS.has(e.kind)) (callIn.get(t) ?? callIn.set(t, new Set()).get(t)!).add(f); }
  // CENTER CLUSTER — a broad concern's shared MECHANISMS (a cluster of beans, not one). Honour the caller's cluster
  // (opts.centers); else detect one intent-weighted center as a fallback. Interactions are the consumers of ANY
  // mechanism + their coupling counterparts, so the star spans the whole cluster.
  const nodes = [...hunkById.keys()];
  if (!nodes.length) return "(empty region)";
  const fanIn = (id: string) => inEdges.get(id)?.size ?? 0;
  const centerRel = (id: string) => (hunkById.get(id)?.relevance ?? -1);
  const haveRel = nodes.some((id) => centerRel(id) >= 0);
  const onIntent = (id: string) => !haveRel || centerRel(id) >= 0.18;
  const byFan = (a: string, b: string) => (fanIn(b) - fanIn(a)) || (Number(!!hunkById.get(b).hub) - Number(!!hunkById.get(a).hub)) || ((hunkById.get(b).complexity ?? 0) - (hunkById.get(a).complexity ?? 0));
  const matchNode = (c: { file: string; symbol: string }) => nodes.find((id) => { const h = hunkById.get(id); return h?.file && String(h.file).replace(/^\.\//, "").endsWith(c.file.replace(/^\.\//, "")) && h?.label === c.symbol; });
  let centerIds: string[] = (opts.centers?.length ? [...new Set(opts.centers.map(matchNode).filter((x): x is string => !!x))] : [])
    .length ? [...new Set(opts.centers!.map(matchNode).filter((x): x is string => !!x))]
    : [(nodes.filter(onIntent).sort(byFan)[0]) ?? nodes.slice().sort(byFan)[0]];
  centerIds = centerIds.filter(Boolean).sort(byFan);
  const centerSet = new Set(centerIds);
  // The mechanism INCLUDES its own method nodes: a consumer that calls `bean.createBooking()` reaches the
  // mechanism through the METHOD node (`BookingsBean.createBooking`), not the class the center pick named — and
  // may never reference the class directly (an injected / parameter-passed bean), so scanning consumers of the
  // class alone MISSES it (Acme: `AcmeCheckBookingsService.createBooking` grown but not an interaction).
  // centerSet stays the DISPLAY set (the mechanism lines); mechNodes is the interaction boundary (a method is
  // never its own interaction, and the entry walk halts at any mechanism node).
  const centerLabels = new Set([...centerSet].map((c) => hunkById.get(c)?.label).filter(Boolean));
  const mechNodes = new Set<string>(centerSet);
  for (const id of nodes) { const h = hunkById.get(id); if (h?.enclosing && centerLabels.has(h.enclosing)) mechNodes.add(id); }
  const primary = hunkById.get(centerIds[0]);
  // INTERACTIONS = consumers of ANY mechanism (its class OR its methods), each walked UP to its entry point
  // (stopping at any mechanism), so a ray is named by its interaction. Deduped by entry.
  const entryOf = (start: string): string => {
    let cur = start; const seen = new Set<string>(mechNodes);
    for (let hop = 0; hop < 8; hop++) {
      if (seen.has(cur)) break; seen.add(cur);
      const callers = [...(callIn.get(cur) ?? [])].filter((c) => !seen.has(c));   // CALL-graph callers only (skip crossings)
      if (!callers.length) return cur;                 // no caller → an entry point (a coupling reader is its own entry)
      cur = callers.sort((a, b) => (fanIn(a) - fanIn(b)))[0];   // climb the least-shared caller (toward a specific entry)
    }
    return cur;
  };
  const tierRank = (s?: Seam) => (s?.tier === "spine" ? 0 : s?.tier === "off" ? 2 : 1);
  // QUALIFY a node for display with its owning class (`Class.method`) — DISPLAY only; the raw `label` stays bare
  // for the --grow-from handle + center-matching. Disambiguates a bare `createBooking` across sibling beans.
  const qual = (h: any): string => (h?.enclosing && h.enclosing !== h.label ? `${h.enclosing}.${h.label}` : (h?.label ?? "?"));
  // a BOUNDARY node (a route/table/queue/… crossing site) is the medium, never an interaction ENTRY — it renders
  // as `/route (file:0)`, a fake entry. Identified by the `kind` the hunk now carries for boundary nodes only.
  const isBoundaryNode = (id: string): boolean => _BOUND_KINDS.has(hunkById.get(id)?.kind ?? "");
  // A boundary rendered as a flow EDGE label — the MEDIUM (from the boundary node's structural kind, the registry's
  // closed set) + the shared key/route — so the coupling shows AS a link in the chain
  // (acmeBooking.js ──HTTP /booking/*──▶ ●) instead of being buried in a separate "Blindspots" list. THIS is the
  // agent's ask: the crossing is a first-class edge in the flow, not prose.
  const _MEDIUM_LABEL: Record<string, string> = {
    route: "HTTP", "http-route": "HTTP", annotation: "HTTP", "db-table": "db", table: "db",
    queue: "queue", topic: "topic", event: "event", cache: "cache", key: "key", binding: "binds", file: "file",
  };
  const crossingEdge = (bid: string): string => {
    const h = hunkById.get(bid); const med = _MEDIUM_LABEL[h?.kind ?? ""] ?? "crosses"; const key = h?.label ?? "?";
    return med === "db" ? `${med} "${key}"` : `${med} ${key}`;
  };
  const rayCross = new Map<string, Set<string>>();   // interaction entry → the boundary id(s) its ray crosses (for the inline edge)
  // COUPLING interactions — a node sharing a data-key BOUNDARY with a mechanism (the bean writes a table a reporting
  // job READS → that job is an interaction though it never CALLS the bean). 2 hops over crossings; boundary skipped.
  const crossAdj = new Map<string, Set<string>>();
  for (const e of edges) { if (!_CROSS_KINDS.has(e.kind)) continue; const f = String(e.from), t = String(e.to);
    (crossAdj.get(f) ?? crossAdj.set(f, new Set()).get(f)!).add(t); (crossAdj.get(t) ?? crossAdj.set(t, new Set()).get(t)!).add(f); }
  // Rays are keyed by ENTRY (the least-shared caller a consumer climbs to), but MANY operations climb to the
  // same entry (createBooking/updateBooking/cancelBooking → an orchestrator `book`). Keeping ONE `via` per entry
  // hid all but the first — the dev saw `book` but not `createBooking` (Acme). ACCUMULATE the distinct
  // vias so the entry lists every operation reaching it: `via book, createBooking, updateBooking, …`.
  const rays = new Map<string, { entry: string; vias: Set<string> }>();   // entry id → {entry, the operations reaching a mechanism through it}
  const addRay = (entry: string, via: string) => { if (mechNodes.has(entry)) return; const r = rays.get(entry) ?? { entry, vias: new Set<string>() }; r.vias.add(via); rays.set(entry, r); };
  for (const cid of mechNodes)   // consumers of the mechanism's CLASS or any of its METHODS
    for (const consumer of (callIn.get(cid) ?? [])) { if (mechNodes.has(consumer)) continue; addRay(entryOf(consumer), qual(hunkById.get(consumer))); }
  // CROSS-STACK interactions — the boundary (a route/table/queue) can sit on an INTERMEDIATE that reaches the
  // mechanism (a REST endpoint the bean sits BEHIND), NOT on the center itself: a Java bean's JS front-end
  // consumer crosses the route to the ENDPOINT, never to the bean, so a center-only crossing scan hides it (the
  // cross-stack half is grown but invisible on the map — the whole point of Seam). Walk the mechanism's call-
  // UPSTREAM closure (every node that reaches a center through calls) and surface the crossing counterpart of ANY
  // of them. The boundary node (b) is skipped; the counterpart (y) is the interaction, walked up to its OWN
  // (front-end) entry — and if that entry climbed out of the grown region, surface the counterpart itself.
  const upstream = new Set<string>(mechNodes);
  const ust = [...mechNodes];
  while (ust.length) { const n = ust.pop()!; for (const c of (callIn.get(n) ?? [])) if (!upstream.has(c)) { upstream.add(c); ust.push(c); } }
  // the BOUNDARY nodes the mechanism sits on (the route/table/key sites, crossing-adjacent to the upstream); their
  // OTHER neighbours are the cross-stack counterparts (code sharing the boundary). Skip a boundary itself as a
  // counterpart — it's the medium, not an interaction (a `/route` or `table` node would render as a fake entry).
  const boundaries = new Set<string>();
  for (const n of upstream) for (const b of (crossAdj.get(n) ?? [])) boundaries.add(b);
  const _isSym = (l: unknown): l is string => typeof l === "string" && /^[A-Za-z_$][\w$]*$/.test(l);
  for (const b of boundaries) for (const y of (crossAdj.get(b) ?? [])) {
    if (upstream.has(y) || boundaries.has(y) || isBoundaryNode(y) || !hunkById.has(y)) continue;   // Java call-side / a boundary node (route/…) / non-region → not a counterpart
    let e = entryOf(y); const eh = hunkById.get(e); if (!eh?.file || !eh?.label) e = y;   // entry left the region → surface the counterpart node itself
    if (mechNodes.has(e) || upstream.has(e) || boundaries.has(e)) continue;
    // OPERATION-named boundaries: a DECLARATIVE endpoint-map client names each OP as a route node's label
    // (`createBooking`/`getBookings`/`updateBooking`) instead of a raw `/path`, and they fold into one code entry
    // (`install`). The ops CHAIN as route nodes off one another (install → updateBooking → createBooking → …),
    // so collect every op-labelled route boundary reachable from the counterpart THROUGH the route-node chain
    // (hopping only route→route, ≤ a small cap) → the map shows `via createBooking, getBookings, updateBooking`.
    const ops = new Set<string>();
    const seenR = new Set<string>([y]); const stack = [...(crossAdj.get(y) ?? [])];
    while (stack.length && seenR.size < 64) { const r = stack.pop()!; if (seenR.has(r)) continue; seenR.add(r);
      const rh = hunkById.get(r); if (rh?.kind !== "route") continue;   // hop ONLY through route boundary nodes (stops at code/producers)
      if (_isSym(rh.label)) ops.add(rh.label);
      for (const nx of (crossAdj.get(r) ?? [])) if (!seenR.has(nx)) stack.push(nx);
    }
    if (ops.size) for (const op of ops) addRay(e, op);
    else addRay(e, `the ${hunkById.get(b)?.label ?? "shared key"} boundary`);
    if (!mechNodes.has(e)) (rayCross.get(e) ?? rayCross.set(e, new Set()).get(e)!).add(b);   // this ray crosses boundary b → thread it as an edge
  }
  // DROP dead entries — a ray whose entry node has no location (a synthetic boundary/blindspot node that leaked
  // in) would render as `? (?:0)` with a `--grow-from undefined#undefined` handle. Never emit those.
  const rayList = [...rays.values()].filter((r) => { const h = hunkById.get(r.entry); return h?.file && h?.label && !isBoundaryNode(r.entry); }).sort((a, b) =>
    (tierRank(seamOf.get(a.entry)) - tierRank(seamOf.get(b.entry))) ||   // spine interactions first
    (centerRel(b.entry) - centerRel(a.entry)) ||                         // then most intent-relevant
    (String(hunkById.get(a.entry)?.label) < String(hunkById.get(b.entry)?.label) ? -1 : 1));
  // OUT crossings — the boundaries the MECHANISM itself produces to / consumes: the db table it writes, the queue it
  // publishes — the "what a booking DOES" half of the star. Direction from the crossing edge (_CROSS_SOURCE =
  // code→boundary = writes; _CROSS_SINK = boundary→code = reads). Rendered as `● ──writes──▶ db "Booking"`.
  const outCross = new Map<string, string>();   // boundary id → verb (writes / reads)
  for (const e of edges) {
    if (!_CROSS_KINDS.has(e.kind)) continue; const f = String(e.from), t = String(e.to);
    if (mechNodes.has(f) && isBoundaryNode(t)) outCross.set(t, _CROSS_SOURCE.has(e.kind) ? "writes" : "reads");
    else if (mechNodes.has(t) && isBoundaryNode(f)) outCross.set(f, _CROSS_SINK.has(e.kind) ? "reads" : "writes");
  }
  // A grow-from handle needs a real SYMBOL. A file/module node's label is the filename (`provisioning.ts`), so
  // `file#provisioning.ts` is not a valid anchor — render the interaction, but omit the broken deepen handle.
  const symLike = (l: unknown): l is string => typeof l === "string" && /^[A-Za-z_$][\w$]*$/.test(l);
  const cap = Math.max(1, parseInt(process.env.SEAM_CONCERN_CAP ?? "50", 10) || 50);   // a big concern stays scannable
  const q = opts.intent ? ` --intent "${opts.intent}"` : "";
  const where = (h: any) => `${qual(h)} (${h?.file ?? "?"}:${h?.start ?? 0})`;
  // the operations reaching a mechanism through this entry, distinct, capped + counted (a fat orchestrator stays
  // scannable). The entry's OWN name (when it is itself a direct consumer) sorts first; other operations follow.
  const _VIA_CAP = Math.max(1, parseInt(process.env.SEAM_CONCERN_VIAS ?? "8", 10) || 8);
  const viasStr = (r: { entry: string; vias: Set<string> }): string => {
    const self = qual(hunkById.get(r.entry));
    // DROP the raw "the /X boundary" vias — the crossing is now rendered as the flow EDGE (──HTTP /X──▶), so
    // repeating it in the via list is noise. Operation-named vias (createBooking, getBookings) stay: they say
    // WHICH ops reach the mechanism, which the edge (the path) doesn't.
    const v = [...r.vias].filter((x) => !/^the .+ boundary$/.test(x)).sort((a, b) => (Number(b === self) - Number(a === self)) || (a < b ? -1 : 1));
    return v.slice(0, _VIA_CAP).join(", ") + (v.length > _VIA_CAP ? `, … (+${v.length - _VIA_CAP})` : "");
  };
  // DIAGNOSTIC (SEAM_FP_DEBUG): the FULL interaction list before the cap + which are CUT. "Why is X missing":
  // absent here = not enumerated (grow/coupling gap); present-but-CUT = raise SEAM_CONCERN_CAP; in a `via` list =
  // it reaches the mechanism through that entry (now shown, not silently folded away).
  if (process.env.SEAM_FP_DEBUG) {
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
  const _OPS_CAP = Math.max(4, parseInt(process.env.SEAM_CONCERN_OPS ?? "16", 10) || 16);
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
  // IN — who triggers the mechanism, each interaction THREADED through the boundary crossing it traverses
  // (entry ──HTTP /route──▶ ●), so the coupling edge is part of the flow, not a footnote. Deepen recipe stated ONCE.
  out.push("", `## In — what triggers ${dot}  (entry ──crossing──▶ ●)`);
  if (rayList.length) out.push(`  deepen any: seam --grow-from <file>#<symbol>${q}`);
  for (const r of rayList.slice(0, cap)) { const eh = hunkById.get(r.entry);
    const rel = seamOf.get(r.entry)?.tier ? ` [${seamOf.get(r.entry)!.tier}]` : "";
    const xs = [...new Set([...(rayCross.get(r.entry) ?? [])].map(crossingEdge))].slice(0, 2);
    const edge = xs.length ? ` ──${xs.join(" / ")}──▶ ●` : " ──▶ ●";   // the boundary crossing as the flow edge
    const via = viasStr(r); const viaStr = via ? `  (via ${via})` : "";
    const handle = symLike(eh?.label) ? `   grow: ${eh.file}#${eh.label}` : "";   // bare handle; the recipe above is the full command
    out.push(`  ${where(eh)}${rel}${edge}${viaStr}${handle}`); }
  if (rayList.length > cap) out.push(`  (+${rayList.length - cap} more interaction(s) — raise SEAM_CONCERN_CAP)`);
  // OUT — what the mechanism itself does: the boundaries it writes/reads (db table, queue), threaded as edges off ●.
  if (outCross.size) {
    out.push("", `## Out — what ${dot} does  (● ──writes/reads──▶ boundary)`);
    for (const [bid, verb] of outCross) out.push(`  ● ──${verb}──▶ ${crossingEdge(bid)}`);
  }
  // blindspots (reuse the fanout collapse idea, kept short)
  const bs = (model.blindspots ?? []) as any[];
  if (bs.length) { const keys = [...new Set(bs.map((b) => (b.candidates ?? [])[0]?.symbol ?? b.mechanism).filter(Boolean))];
    out.push("", `## Blindspots — ${bs.length} boundary/opaque site(s) over: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", …" : ""}`); }
  return out.join("\n");
}
