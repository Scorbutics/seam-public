// TERMINAL-ANCHORED SPINE — extracted from llm_context.ts's `renderAgent` (Phase 3.x) so a second render family
// (renderConcern's per-mechanism "## Spines" section) can compute the SAME entry→…→anchor→…→boundary path for
// an ARBITRARY node, not just `model.anchor`. This module carries NO behavioural change from the original
// inline closures — only (a) the small per-render maps (label/seamOfId/fileOfId/startOfId/kindOfId/allIds/
// seamIds/primaryHunk/isBoundarySeam/ext) were pulled into one `buildDerivedIndex` so renderAgent and
// `computeSpine` share ONE derivation instead of two copies, and (b) every read of `model.anchor` became the
// `anchorId` parameter. The decision logic itself (rank order, thresholds, trust-gate/closure-depth/delegate-hop/
// overattrib-K heuristics, env var names/defaults) is an untouched, oracle-tuned CONTRACT — see the inline
// comments below (kept verbatim) for why each rule exists.
import { type Hunk, type Seam, filesOf } from "./vocab.js";
import { CROSS_KINDS as _CROSS_KINDS, STORE_KINDS as _STORE_KINDS, BOUND_KINDS as _BOUND_KINDS } from "./medium_registry.js";

export type DerivedIndex = {
  label: Map<string, string>;
  seamOfId: Map<string, string>;
  fileOfId: Map<string, string>;
  startOfId: Map<string, number>;
  kindOfId: Map<string, string>;
  allIds: Set<string>;
  seamIds: (s: Seam) => Set<string>;
  primaryHunk: (s: Seam) => any;
  isBoundarySeam: (s: Seam) => boolean;
  ext: (f?: string) => string;
};

// The per-render derivation every spine/region view needs: id → label + the seam each node lives in (for reach
// phrases that stop at the seam boundary), plus id → file/start so a spine can print the EXACT CALL SITE per hop.
export function buildDerivedIndex(seams: Seam[]): DerivedIndex {
  const label = new Map<string, string>();
  const seamOfId = new Map<string, string>();
  const fileOfId = new Map<string, string>();
  const startOfId = new Map<string, number>();
  const kindOfId = new Map<string, string>();
  for (const s of seams) for (const h of (s.hunks ?? [])) { const id = (h as any).id; if (id != null) { const k = String(id); label.set(k, h.label ?? s.label); seamOfId.set(k, s.id); if (h.file) fileOfId.set(k, h.file); if (typeof h.start === "number") startOfId.set(k, h.start); if (h.kind) kindOfId.set(k, h.kind); } }
  const allIds = new Set(label.keys());
  const seamIds = (s: Seam) => new Set((s.hunks ?? []).map((h) => String((h as any).id)).filter((x) => x !== "undefined"));
  // primaryHunk / isBoundarySeam: the seam's own primary hunk (its structural kind), and whether that kind is a
  // boundary (db-table/route/queue/…) — used throughout the spine to tell a real code seam from the crossing plumbing.
  const primaryHunk = (s: Seam) => (s.hunks ?? []).find((h) => h.label === s.primary?.symbol && h.file === s.primary?.file) ?? (s.hunks ?? [])[0];
  const isBoundarySeam = (s: Seam) => _BOUND_KINDS.has((primaryHunk(s) as any)?.kind ?? "");
  // "Other side" is a DIFFERENT language than the spine (Java backend ⇄ JS frontend) — the file EXTENSION is the
  // structural signal (the file's own type, not a name guess). A same-language self-route hop is NOT cross-stack.
  const ext = (f?: string) => { const s = f ?? ""; const i = s.lastIndexOf("."); return i >= 0 ? s.slice(i + 1).toLowerCase() : ""; };
  return { label, seamOfId, fileOfId, startOfId, kindOfId, allIds, seamIds, primaryHunk, isBoundarySeam, ext };
}

export type SpineResult = {
  // downSpine: the anchor-DOWNSTREAM half only (anchor's own seam → … → grounded sink), always node-scoped to
  // `anchorId` at index 0 when non-empty. entryChain: the UPSTREAM half (SEAM_SPINE_ENTRY), a GENERIC "deepest/
  // cross-stack caller" walk — correct for a SINGLE anchor (renderAgent), but NOT mechanism-scoped: run per
  // fanned method through a shared caller (a dispatcher/gateway), it converges on whichever sibling has the
  // deepest onward caller, not on who actually calls THIS anchor. A multi-mechanism caller (renderConcern's
  // "## Spines") must NOT trust this half — it already has a mechanism-specific, hub-safe entry climb (`entryOf`)
  // and should splice that in instead; keep the two halves separate so it can.
  downSpine: Seam[];
  entryChain: Seam[];
  spineAlternates: Seam[];
  grounded: boolean;
  terminal: "grounded" | "frontier" | "none";
  breakInfo?: any;
};

const tierOf = (s: Seam) => s.tier ?? "";

// computeSpine — the anchor-agnostic entry point: `anchorId` is any node in the footprint (renderAgent passes
// `model.anchor`; renderConcern's "## Spines" section passes each mechanism's own center node). Returns the fully
// assembled spineSeams (entry-chain + down-spine already combined, matching renderAgent's old inline assembly).
export function computeSpine(model: any, anchorId: string, seams: Seam[], idx: DerivedIndex): SpineResult {
  const { label, seamOfId, fileOfId, kindOfId, primaryHunk, isBoundarySeam } = idx;

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
    const anchorSeam = seamOfId.get(String(anchorId));
    if (!anchorSeam) return empty;
    const anchorNode = String(anchorId);   // the anchor NODE, not its (often god-class / merged-blob) seam
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
    for (const q2 = [anchorNode]; q2.length; ) {
      const c = q2.shift()!; const d = callDepth.get(c)!;
      if (d >= _closureMax) continue;
      for (const e of edges) {
        if (String(e.from) !== c) continue;
        const isCall = _DELEGATE.has(e.kind) || (e.kind === "import" && Number(e.line) > 0);
        if (!isCall) continue;
        const to = String(e.to);
        if (!label.has(to) || _TYPEREF.has(kindOfId.get(to) ?? "") || callDepth.has(to)) continue;   // resolved, non-type, unseen
        callDepth.set(to, d + 1); q2.push(to);
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
    // FLOW-WRITE VOLUME — the table the flow's MECHANISM centers on: how many DISTINCT nodes ON THE ANCHOR'S CALL
    // CLOSURE write it. A payment flow's `payments` is written by 4 phases (provision/enrich/invoice/notify); a
    // side table like `member_referrals` by 1 — or ZERO on the closure when it's reached only via a coupling
    // crossing from an UNRELATED route (the pilot's synthetic-referees admin route wrote `member_referrals` and,
    // being dist-closer than the deep phase writes, hijacked the crown from `payments`). So a boundary written by
    // MORE call-closure nodes is the real culmination; a coupling-ONLY boundary is a side channel. SCOPED to the
    // call closure (never repo-wide), keyed by TABLE LABEL, so a hub table's global write count can't hijack it.
    const _flowWritersByTbl = new Map<string, Set<string>>();
    for (const e of edges) if (_PRODUCE.has(e.kind) && callDepth.has(String(e.from))) { const t = label.get(String(e.to)) ?? String(e.to); (_flowWritersByTbl.get(t) ?? _flowWritersByTbl.set(t, new Set()).get(t)!).add(String(e.from)); }
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
    // how many distinct call-closure nodes write this boundary's table (see _flowWritersByTbl) — the flow-subject signal.
    const _flowWriters = (s: Seam) => _flowWritersByTbl.get(_tblOf(s))?.size ?? 0;
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
    // …UNLESS the anchor's own CALL CLOSURE writes it MORE THAN ONCE. A table the flow's mechanism produces into
    // across MULTIPLE steps (private-app `payments`, written by its runPhaseEnrich/Invoice/Notify phases — _flowWriters ≥ 2)
    // is the SUBJECT even when it's globally a shared-key hub (written across 10 files → flagged shared-key-fanout);
    // excluding it crowned a write-light side table (`member_referrals`) reached only via an unrelated admin route
    // (the pilot bug). A single incidental write to a hub (keycloak addRealmRoleMappings' one `db-write` to the
    // `clients` hub read in 26 files) is NOT the subject — stays excluded. So the override needs ≥2 closure writers.
    const _isHubCrossing = (s: Seam) => (s as any).proposedBy === "crossing" && _hubTables.has(_tblOf(s)) && _flowWriters(s) < 2;
    const cands = seams.filter((s) => isBoundarySeam(s) && s.id !== anchorSeam && !_isHubCrossing(s)
        && (dist.has(s.id) || trustedDirect(s) || trustedChain(s))
        && (isStoreSink(s) || trustedDirect(s) || trustedChain(s) || ((s as any).region?.direction ?? "down") === "down"))
      .sort((a, b) => (_sinkRank(b) - _sinkRank(a)) || (Number(directSink(b)) - Number(directSink(a))) || (Number(providerWrite(b)) - Number(providerWrite(a))) || (_flowWriters(b) - _flowWriters(a)) || (Number(_onSubject(b)) - Number(_onSubject(a))) || (_dist(b.id) - _dist(a.id)) || writeOrder(a, b) || (((b as any).hunks?.length ?? 0) - ((a as any).hunks?.length ?? 0)) || (a.id < b.id ? -1 : 1));
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
  const _downSpine = _spine.path.length ? _spine.path
    : (process.env.SEAM_SPINE_TRUST_GATE !== "0" && _spine.reachSet.size
        ? seams.filter((s) => tierOf(s) === "spine" && _spine.reachSet.has(s.id))
        : seams.filter((s) => tierOf(s) === "spine"));
  // ENTRY-ROOTED SPINE (SEAM_SPINE_ENTRY, default-off) — the core spine is DOWNSTREAM-only (anchor → sink), so a
  // MID-flow anchor leaves the flow's ENTRY (the member's UI action / REST endpoint) in the region, not the spine.
  // Trace UP over CALLER edges (the `reachSeam` convention: caller = e.from, callee = e.to — NO fwd flip; that's how
  // the render derives "called by X"), hopping the cross-stack ROUTE crossing to the front-end, then PREPEND `entry →
  // … → anchor`. NOTE seamOfId maps a node → the seam's ID STRING; byId maps that back to the Seam. A STORE seam is a
  // SINK, never a caller (excluded, else the anchor's own db-write back-edge reads as an upstream caller). Entry =
  // deepest reached CODE seam (has source files, not boundary/store), preferring one across a crossing (the UI).
  // ADDITIVE: the tuned down-only core is untouched; only prepends, only when a grounded downstream spine exists.
  const _entryChain = (): Seam[] => {
    if (process.env.SEAM_SPINE_ENTRY !== "1" || !_downSpine.length) return [];
    const anchorSid = seamOfId.get(String(anchorId));
    if (!anchorSid) return [];
    const byId = new Map(seams.map((s) => [s.id, s]));
    const isStore = (sid: string) => { const s = byId.get(sid); return !!s && _STORE_KINDS.has((primaryHunk(s) as any)?.kind ?? ""); };
    const isCode = (sid: string) => { const s = byId.get(sid); return !!s && sid !== anchorSid && filesOf(s).length > 0 && !isBoundarySeam(s) && !isStore(sid); };
    const up = new Map<string, { sid: string; cross: boolean }[]>();   // callee seam → its caller seams (caller = e.from)
    const addUp = (callee: string, caller: string, cross: boolean) => { if (callee !== caller && !isStore(caller)) (up.get(callee) ?? up.set(callee, []).get(callee)!).push({ sid: caller, cross }); };
    for (const e of (model.edges ?? []) as any[]) {
      if (e.kind === "contains") continue;
      const fromSid = seamOfId.get(String(e.from)), toSid = seamOfId.get(String(e.to));
      if (!fromSid || !toSid) continue;
      // A CALL edge is directional: caller = e.from. A CROSS-STACK crossing (HTTP route) is a PEER relationship —
      // the UI and the REST handler both attach to the route boundary — so walk it BOTH ways to reach the front-end.
      if (_CROSS_KINDS.has(e.kind)) { addUp(fromSid, toSid, true); addUp(toSid, fromSid, true); }
      else addUp(toSid, fromSid, false);
    }
    const dist = new Map<string, number>([[anchorSid, 0]]); const prev = new Map<string, string>(); const crossHop = new Set<string>();
    for (const q = [anchorSid]; q.length; ) {
      const c = q.shift()!; const d = dist.get(c)!;
      for (const { sid, cross } of up.get(c) ?? []) if (!dist.has(sid)) { dist.set(sid, d + 1); prev.set(sid, c); q.push(sid); if (cross) crossHop.add(sid); }
    }
    const cand = [...dist].filter(([sid]) => isCode(sid)).map(([sid, d]) => ({ sid, d, cross: crossHop.has(sid) }));
    if (!cand.length) return [];
    cand.sort((a, b) => (Number(b.cross) - Number(a.cross)) || (b.d - a.d));   // prefer the cross-stack (UI) entry, else the deepest code caller
    const path: Seam[] = []; const seen = new Set<string>();
    for (let sid: string | undefined = cand[0].sid; sid && sid !== anchorSid; sid = prev.get(sid)) { const s = byId.get(sid); if (s && isCode(sid) && !seen.has(sid)) { seen.add(sid); path.push(s); } }
    return path;   // entry → … → caller-of-anchor
  };
  const _entry = _entryChain(); const _dset = new Set(_downSpine.map((s) => s.id));
  const spineAlternates = _spine.alternates;
  return { downSpine: _downSpine, entryChain: _entry.filter((s) => !_dset.has(s.id)), spineAlternates, grounded: spineGrounded, terminal: spineTerminal, breakInfo: spineBreak };
}
