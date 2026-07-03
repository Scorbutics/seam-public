// CONCERN CENTER detection (deterministic, structural). A "concern" question ("how are bookings managed?") has
// no entry point — it has a shared MECHANISM (a bean / service / table) that every interaction delegates through.
// That mechanism is the node with the highest FAN-IN (most distinct consumers) in the intent-scoped region: on
// Acme, the `BookingsBean` all the admin/member/API/job paths call. This is a STRUCTURAL fact (in-degree
// over the resolved graph), not a name guess — the intent already scoped the region via the grow, so the
// most-consumed node in it IS the concern's center. Feeds the re-anchor: grow FROM the center → the star of
// interactions, robustly, no matter which point the auto-anchor happened to land on.
export interface Center { id: string; file: string; symbol: string; fanIn: number; }

// STRUCTURE deduces the candidates (the shared, high-fan-in nodes); the intent field (embeddings) judges WHICH of
// them the concern is ABOUT — the CLAUDE.md structural↔semantic split. Structure alone CANNOT separate a generic
// ubiquitous ENTITY (`User`, fan-in 61, referenced by census/crypto/bookings alike) from the concern's MECHANISM
// (`BookingsBean`, fan-in 14): both are structural hubs. So `relevance(file)` (when available) FILTERS to on-intent
// nodes first — `User` scores off-intent for "how are bookings managed" and drops out; among the on-intent
// survivors the highest fan-in is the center. No relevance / nothing clears the floor → raw fan-in (I5 degradation).
type CenterOpts = { minFanIn?: number; excludeFile?: string; excludeSymbol?: string; anchorId?: string; relevance?: (n: { symbol: string; file: string }) => number; minRelevance?: number; debug?: (line: string) => void };

// Undirected hop-distance from the anchor over the resolved graph (calls/deps/refs/coupling, sans containment).
// The concern's mechanism sits ON the anchor's flow; a far subsystem the over-grown region merely touched is not
// it. Undirected because the mechanism may be a caller OR a callee of the anchor (createBooking's orchestrator
// above it, its persistence below).
function _hopsFrom(data: any, anchorId: string): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const e of data.edges ?? []) {
    if (e.kind === "contains") continue;
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const hops = new Map<string, number>([[anchorId, 0]]);
  let frontier = [anchorId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) for (const nb of adj.get(id) ?? []) if (!hops.has(nb)) { hops.set(nb, hops.get(id)! + 1); next.push(nb); }
    frontier = next;
  }
  return hops;
}

// A broad concern ("how are bookings managed?") has NO single entry — it has a CLUSTER of mechanism nodes.
// detectCenters returns the top-K, ranked by a GROUNDED score = log-fan-in × intent-relevance × proximity-to-anchor:
//   • RELEVANCE (embeddings) is the semantic filter — an off-intent ubiquitous entity (`User`) drops out.
//   • LOG fan-in, not raw — raw fan-in lets a ubiquitous UI hub (`useBookerStoreContext`, fan-in 49) swamp the
//     flow the intent names (`createBooking`, fan-in 5). Log compresses that ubiquity bias so it informs, not dominates.
//   • PROXIMITY to the anchor (when `anchorId` given) is the grounded prior: the mechanism is 1–2 hops from what the
//     dev pointed at, not a distant subsystem. This is what stops the drift to the Booker UI store on cal.com, while
//     preserving wrong-anchor resistance (a LEAF anchor still has low fan-in, so it never dominates its own flow).
// No relevance / nothing clears the floor → the single raw-highest-fan-in node (degenerate, I5).
export function detectCenters(data: any, opts: CenterOpts = {}, k = 4): Center[] {
  const minFanIn = opts.minFanIn ?? 2;
  const minRel = opts.minRelevance ?? 0.18;
  const byId = new Map<string, any>((data.nodes ?? []).map((n: any) => [n.id, n]));
  const callers = new Map<string, Set<string>>();   // DISTINCT consumers per node (a caller counts once), sans containment
  for (const e of data.edges ?? []) {
    if (e.kind === "contains") continue;
    (callers.get(e.to) ?? callers.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const hops = opts.anchorId ? _hopsFrom(data, opts.anchorId) : null;
  const prox = (id: string) => hops ? 1 / (1 + (hops.get(id) ?? 99)) : 1;   // near-anchor favoured; unreachable ≈ 0
  // per-SYMBOL relevance (not file-max — sharper: `User` vs `BookingsBean` directly). The anchor competes as a
  // candidate (no hard exclusion when anchorId is given) — a good anchor IS the mechanism the dev pointed at.
  const cands = [...callers.entries()].map(([id]) => byId.get(id))
    .filter((n) => n && n.file && n.symbol && !(n.file === opts.excludeFile && n.symbol === opts.excludeSymbol))
    .map((n) => ({ n, fan: callers.get(n.id)!.size, rel: opts.relevance ? opts.relevance({ symbol: n.symbol, file: n.file }) : 1, hop: hops?.get(n.id) ?? 99 }))
    .sort((a, b) => (b.fan - a.fan) || ((b.n.complexity ?? 0) - (a.n.complexity ?? 0)));
  const mk = (c: any): Center => ({ id: c.n.id, file: c.n.file, symbol: c.n.symbol, fanIn: c.fan });
  const score = (c: any) => Math.log2(1 + c.fan) * Math.max(c.rel, 0) * prox(c.n.id);
  const onIntent = (opts.relevance ? cands.filter((c) => c.fan >= minFanIn && c.rel >= minRel) : []).sort((a, b) => score(b) - score(a));
  if (opts.debug && cands.length) {
    const tag = (c: any) => `${c.n.symbol}(${c.fan}·r${c.rel.toFixed(2)}${hops ? `·h${c.hop}` : ""})`;
    opts.debug(`[concern] center candidates by fan-in: ${cands.slice(0, 8).map(tag).join(", ")}`);
    if (onIntent.length) opts.debug(`[concern] on-intent mechanisms by log-fan×rel×prox: ${onIntent.slice(0, 8).map((c) => `${tag(c)}=${score(c).toFixed(2)}`).join(", ")}`);
  }
  if (onIntent.length) return onIntent.slice(0, Math.max(1, k)).map(mk);
  const raw = cands.find((c) => c.fan >= minFanIn);   // no on-intent survivor → the single raw-highest-fan-in node
  return raw ? [mk(raw)] : [];
}

// Single-center convenience (the highest-ranked mechanism) — back-compat + the degenerate concern.
export function detectCenter(data: any, opts: CenterOpts = {}): Center | null {
  return detectCenters(data, opts, 1)[0] ?? null;
}
