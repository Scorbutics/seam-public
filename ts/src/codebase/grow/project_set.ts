// PROJECTION — the "consumers-of" SET shape. Where grow/orchestrate.ts turns a footprint into an ordered
// SPINE (a flow), this stops at the resolved in-edge SET and refuses (honestly) when there is no
// structural answer. A spine is one projection of the ResolvedGraph; this is its sibling — the set of
// who actually consumes the anchor, each member carrying its resolution tier (RESOLVED_FULL/PARTIAL/
// SUGGESTED) so the answer is self-describing about how much is verified vs assumed.
//
// The point is the SHORT-CIRCUIT: a consumers-of question is a set, not a path. Feeding it through grow →
// cluster → spine over-structures a set into a flow that isn't there. This reads the resolved in-edges
// build_consumers_graph already produced and presents them as what they are.
//
// `noStructure` is the dual of anchor_select's `noFlow`: when no caller resolves structurally, Seam says
// so and routes the asker to grep/RAG — owning that boundary honestly is what earns the redirect. SUGGESTED
// (ungrounded) members are leads, not verified consumers, so they do NOT count as structure.
import type { ResolvedGraph, GraphNode, Provenance } from "../scan/graph.js";

// One resolved (or suggested) consumer of the anchor. `line` is 1-BASED (see `to1`) and is the grounded
// USAGE/CALL site when the edge carries one — the line the engineer must actually edit — falling back to the
// member's own declaration start only when no call line was grounded.
export interface ConsumerMember {
  symbol: string;
  file: string;
  line: number;
  kind: string;
  enclosing: string;
  edgeKind: string;        // "call" | "reference" | a coupling crossing label
  provenance: Provenance;  // RESOLVED_FULL | RESOLVED_PARTIAL | SUGGESTED
  // OPTIONAL DI binding (opt-in SEAM_DI_RESOLVE; TS/ioctopus): when this member is a DI-bound concrete impl,
  // how the runtime container wires it — the token, binding site, and (for a factory) the selecting condition.
  // Recovers the interface→impl→binding hop grep can't, in the same query. See languages/typescript/di_bindings.ts.
  binding?: { token: string; kind: string; impls: string[]; condition?: string; file: string; line: number };
}

// An opaque caller the resolver SAW but could not ground (an unresolved import, an ambiguous dispatch) —
// the honest gap. These are exactly the callers a grep WOULD surface; we name the gap rather than hide it.
export interface UnresolvedCaller {
  mechanism: string;
  evidence: string;
  candidates: string[];
}

// Why noStructure fired: `opaque` = callers exist but none resolve (→ grep/verify); `none` = no caller at
// all (an entry point, dead code, or dispatched-only).
export type NoStructureReason = "opaque" | "none";

export interface ConsumerSet {
  shape: "set" | "deps";    // "set" = consumers (in-edges); "deps" = dependencies (out-edges)
  anchor: { symbol: string; file: string };
  members: ConsumerMember[];          // resolved first, then suggested; stable file/line order within a tier
  unresolved: UnresolvedCaller[];     // opaque callers — the "grep these" bucket
  recalled?: ConsumerMember[];        // name-grounded, UNVERIFIED leads (opt-in --recall) — kept separate
                                      // from the verified `members` so the floor stays trustworthy
  noStructure?: boolean;              // no RESOLVED consumer → not a structural answer
  reason?: NoStructureReason;
  resolutionQuality: string;
}

// Tier order: the verified floor first, the ungrounded lead last. Drives member sorting + the noStructure
// test (only RESOLVED_* counts as structure).
const TIER_RANK: Record<string, number> = { RESOLVED_FULL: 0, RESOLVED_PARTIAL: 1, SUGGESTED: 2 };
const isResolved = (p: Provenance): boolean => p === "RESOLVED_FULL" || p === "RESOLVED_PARTIAL";

// THE LINE CONTRACT — the one place the engine's internal line convention meets the rendered one.
// EVERY line the scan produces is 0-BASED: node.range comes from `Ctx.span`, edge.line from `Ctx.span(call)` /
// `_call_lines` / `_usage_lines`, and `Ctx.ln` returns the count of newlines before the offset. A projected
// member's `line` is what a human/editor jumps to, so it is 1-BASED. Converting per-branch is what produced the
// systematic off-by-one every projected consumer carried (`getUserAvailability.ts:341` for a symbol on 342, and
// the same on every fallback path): one branch added 1, the other passed the raw 0-based value through. Route
// EVERY line through this helper — a raw `range[0]` or `e.line` reaching a member is the bug, by construction.
// EXPORTED because it is the contract for EVERY structural shape, not just this one: impact/reaches/writers/
// coupling project the SAME 0-based scan values and render them as `file:line`, so they convert HERE too.
// (impact was the one shape that didn't: it cited `getUserAvailability.ts:581` — the line ABOVE the real call
// on 582 — while `consumers` on the same anchor said 582. One helper, one convention, no per-shape drift.)
export const to1 = (l: number | null | undefined): number => (l == null ? 0 : l + 1);
// A node's declaration start, or `undefined` when the node is UNLOCATED (its `range` is the [0,0] sentinel
// the up-scan places when no real site was grounded). Shared by every projection that cites a node — see
// GraphNode.unlocated. A projected `line` of 0 means "no line": renderers must print no location at all.
export const _start = (n: { range?: number[]; unlocated?: true } | null | undefined): number | undefined =>
  (!n || n.unlocated) ? undefined : n.range?.[0];

// Project the anchor's direct edges in ONE direction into a SET. `in` = consumers (edges TO the anchor →
// the from-node is a member); `out` = dependencies (edges FROM the anchor → the to-node is a member).
// Reads ONLY the anchor's direct edges + the anchor's blindspots — NOT the depth-2 ripple or coupling
// crossings (those target other nodes and belong to a flow, not the direct set). The two public
// projections below are this with the direction + shape label fixed — symmetric by construction.
function projectEdgeSet(graph: ResolvedGraph, dir: "in" | "out", shape: ConsumerSet["shape"]): ConsumerSet {
  const anchorId = graph.anchor.id;
  const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));

  const members: ConsumerMember[] = [];
  for (const e of graph.edges) {
    const onAnchor = dir === "in" ? e.to === anchorId : e.from === anchorId;
    const otherId = dir === "in" ? e.from : e.to;
    if (!onAnchor || otherId === anchorId) continue;   // direct edges in this direction; never a self-loop
    const n = byId.get(otherId);
    if (!n) continue;
    members.push({
      symbol: n.symbol,
      file: n.file,
      // LOCATION must belong to the MEMBER's own file. `edge.line` is the USAGE/CALL line recorded in the
      // CONSUMER's file, so it is right for `in` (the member IS the consumer — its usage sits in its own file)
      // but WRONG for `out` (the member is the DEP; pairing its file with the anchor's usage line printed
      // impossible locations like `getCalendar.ts:260` for a 121-line file). For `out`, use the dep's own
      // declaration range. See `to1` for the 0-based → 1-based contract.
      // `unlocated` nodes carry the [0,0] SENTINEL, not a range — never fall back to it (that is how a bare
      // barrel re-export got cited as `index.ts:1`). `to1(null)` → 0 = "no line", which the renderer omits.
      line: to1(dir === "in" ? e.line ?? _start(n) : _start(n) ?? e.line),
      kind: n.kind,
      enclosing: n.enclosing ?? "",
      edgeKind: e.kind,
      provenance: e.provenance,
    });
  }
  members.sort((a, b) =>
    (TIER_RANK[a.provenance] ?? 9) - (TIER_RANK[b.provenance] ?? 9)
    || a.file.localeCompare(b.file)
    || a.line - b.line
    || a.symbol.localeCompare(b.symbol));

  const unresolved: UnresolvedCaller[] = graph.blindspots
    .filter((b) => b.node === anchorId)
    .map((b) => ({
      mechanism: b.mechanism,
      evidence: b.evidence,
      candidates: [...new Set((b.candidates ?? []).map((c: any) => c?.symbol).filter(Boolean))] as string[],
    }));

  const set: ConsumerSet = {
    shape,
    anchor: { symbol: graph.anchor.symbol, file: graph.anchor.file },
    members,
    unresolved,
    resolutionQuality: graph.resolutionQuality,
  };

  // noStructure: no member resolved structurally. SUGGESTED/blindspot-only means edges exist but can't be
  // grounded here → route to grep (opaque); nothing at all → a leaf / entry / dead / dispatched (none).
  if (!members.some((m) => isResolved(m.provenance))) {
    set.noStructure = true;
    set.reason = (members.length || unresolved.length) ? "opaque" : "none";
  }
  return set;
}

// CONSUMERS — the anchor's resolved IN-edges (who calls/uses it). See projectEdgeSet.
export function projectConsumerSet(graph: ResolvedGraph): ConsumerSet {
  return projectEdgeSet(graph, "in", "set");
}

// DEPENDENCIES — the anchor's resolved OUT-edges (what it calls/uses). The symmetric peer of consumers;
// build with a DOWN footprint (`direction: "down"`). `noStructure` reason `none` = a leaf (no deps).
export function projectDependencySet(graph: ResolvedGraph): ConsumerSet {
  return projectEdgeSet(graph, "out", "deps");
}

// Fold name-grounded recall candidates into a SET as the SEPARATE `recalled` list (never `members`).
// Recall is for files the structural floor missed ENTIRELY: dedupe by FILE against the verified members,
// so a file the floor already resolved is not re-listed (this also drops the symbol's own import-binding
// line, which the floor handled via the real usage). `nameConsumers` is the raw NameConsumer scan output.
export function attachRecalled(set: ConsumerSet, nameConsumers: { file: string; symbol: string; kind: string; enclosing: string; line: number; call: boolean }[]): ConsumerSet {
  const haveFiles = new Set(set.members.map((m) => m.file));
  const recalled: ConsumerMember[] = [];
  const seen = new Set<string>();
  for (const c of nameConsumers) {
    const k = `${c.file}#${c.symbol}`;
    if (haveFiles.has(c.file) || seen.has(k)) continue;   // file already covered by the floor, or a duplicate
    seen.add(k);
    recalled.push({ symbol: c.symbol, file: c.file, line: to1(c.line), kind: c.kind, enclosing: c.enclosing,   // NameConsumer.line is 0-based too
      edgeKind: c.call ? "name-call" : "name-ref", provenance: "SUGGESTED" });
  }
  recalled.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.symbol.localeCompare(b.symbol));
  if (recalled.length) set.recalled = recalled;
  return set;
}
