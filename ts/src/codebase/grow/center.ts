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
type CenterOpts = { minFanIn?: number; excludeFile?: string; excludeSymbol?: string; relevance?: (n: { symbol: string; file: string }) => number; minRelevance?: number; debug?: (line: string) => void };

// A broad concern ("how are bookings managed?") has NO single center — it is a CLUSTER of mechanism beans
// (`BookingsBean`, `BookingsSetupBean`, `MemberBooking`, `MicrosoftBookingsBean`…). detectCenters returns the top-K
// ON-INTENT, high-fan-in mechanisms, ranked by fan-in × relevance. The caller grows from ALL of them (merged) and
// renders the cluster + the interactions around any of them. Off-intent hubs (`User`) are excluded by the floor;
// no relevance → the single raw-highest-fan-in node (degenerate cluster of one, I5).
export function detectCenters(data: any, opts: CenterOpts = {}, k = 4): Center[] {
  const minFanIn = opts.minFanIn ?? 2;
  const minRel = opts.minRelevance ?? 0.18;
  const byId = new Map<string, any>((data.nodes ?? []).map((n: any) => [n.id, n]));
  const callers = new Map<string, Set<string>>();   // DISTINCT consumers per node (a caller counts once), sans containment
  for (const e of data.edges ?? []) {
    if (e.kind === "contains") continue;
    (callers.get(e.to) ?? callers.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  // per-SYMBOL relevance (not file-max — sharper: `User` vs `BookingsBean` directly, so a stray booking-ish method
  // elsewhere in User.java can't lift the entity in). Rank by fan-in for the diagnostic; by fan×rel for the pick.
  const cands = [...callers.entries()].map(([id, set]) => byId.get(id))
    .filter((n) => n && n.file && n.symbol && !(n.file === opts.excludeFile && n.symbol === opts.excludeSymbol))
    .map((n) => ({ n, fan: callers.get(n.id)!.size, rel: opts.relevance ? opts.relevance({ symbol: n.symbol, file: n.file }) : 1 }))
    .sort((a, b) => (b.fan - a.fan) || ((b.n.complexity ?? 0) - (a.n.complexity ?? 0)));
  const mk = (c: any): Center => ({ id: c.n.id, file: c.n.file, symbol: c.n.symbol, fanIn: c.fan });
  const score = (c: any) => c.fan * Math.max(c.rel, 0);
  const onIntent = (opts.relevance ? cands.filter((c) => c.fan >= minFanIn && c.rel >= minRel) : []).sort((a, b) => score(b) - score(a));
  if (opts.debug && cands.length) {
    opts.debug(`[concern] center candidates by fan-in: ${cands.slice(0, 8).map((c) => `${c.n.symbol}(${c.fan}·${c.rel.toFixed(2)})`).join(", ")}`);
    if (onIntent.length) opts.debug(`[concern] on-intent mechanisms by fan×rel: ${onIntent.slice(0, 8).map((c) => `${c.n.symbol}(${c.fan}·${c.rel.toFixed(2)}=${score(c).toFixed(1)})`).join(", ")}`);
  }
  if (onIntent.length) return onIntent.slice(0, Math.max(1, k)).map(mk);
  const raw = cands.find((c) => c.fan >= minFanIn);   // no on-intent survivor → the single raw-highest-fan-in node
  return raw ? [mk(raw)] : [];
}

// Single-center convenience (the highest-ranked mechanism) — back-compat + the degenerate concern.
export function detectCenter(data: any, opts: CenterOpts = {}): Center | null {
  return detectCenters(data, opts, 1)[0] ?? null;
}
