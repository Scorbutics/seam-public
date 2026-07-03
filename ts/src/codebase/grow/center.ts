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
export function detectCenter(data: any, opts: { minFanIn?: number; excludeFile?: string; excludeSymbol?: string; relevance?: (n: { symbol: string; file: string }) => number; minRelevance?: number; debug?: (line: string) => void } = {}): Center | null {
  const minFanIn = opts.minFanIn ?? 2;
  const minRel = opts.minRelevance ?? 0.18;
  const byId = new Map<string, any>((data.nodes ?? []).map((n: any) => [n.id, n]));
  const callers = new Map<string, Set<string>>();   // DISTINCT consumers per node (a caller counts once), sans containment
  for (const e of data.edges ?? []) {
    if (e.kind === "contains") continue;
    (callers.get(e.to) ?? callers.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  // rank every real-symbol node by fan-in, with its intent relevance (per-SYMBOL, not file-max — sharper: `User`
  // vs `BookingsBean` directly, so a stray booking-ish method elsewhere in User.java can't lift the entity in).
  const cands = [...callers.entries()].map(([id, set]) => byId.get(id))
    .filter((n) => n && n.file && n.symbol && !(n.file === opts.excludeFile && n.symbol === opts.excludeSymbol))
    .map((n) => ({ n, fan: callers.get(n.id)!.size, rel: opts.relevance ? opts.relevance({ symbol: n.symbol, file: n.file }) : 1 }))
    .sort((a, b) => (b.fan - a.fan) || ((b.n.complexity ?? 0) - (a.n.complexity ?? 0)));
  const mk = (c: any): Center => ({ id: c.n.id, file: c.n.file, symbol: c.n.symbol, fanIn: c.fan });
  // Among the ON-INTENT candidates (fan-in ≥ floor AND relevance ≥ floor), pick by fan-in × relevance — so a bean
  // that is MORE about the concern (`BookingsBean`) can beat one with slightly higher raw fan-in but a lower
  // on-concern score (`BookingsSetupBean`). Off-intent hubs (`User`) are already gone. Else raw fan-in (I5).
  const onIntent = opts.relevance ? cands.filter((c) => c.fan >= minFanIn && c.rel >= minRel) : [];
  const score = (c: any) => c.fan * Math.max(c.rel, 0);
  const winner = onIntent.length ? onIntent.reduce((a, b) => (score(b) > score(a) ? b : a)) : null;
  // Diagnostic: the top candidates by raw fan-in AND the top ON-INTENT ones by fan×rel (so a bean the region-local
  // fan-in undercounts still shows its relevance — the data to tune the pick against a real repo).
  if (opts.debug && cands.length) {
    opts.debug(`[concern] center candidates by fan-in: ${cands.slice(0, 8).map((c) => `${c.n.symbol}(${c.fan}·${c.rel.toFixed(2)})`).join(", ")}`);
    if (onIntent.length) opts.debug(`[concern] on-intent by fan×rel: ${[...onIntent].sort((a, b) => score(b) - score(a)).slice(0, 8).map((c) => `${c.n.symbol}(${c.fan}·${c.rel.toFixed(2)}=${score(c).toFixed(1)})`).join(", ")}`);
  }
  const raw = cands.find((c) => c.fan >= minFanIn);
  return winner ? mk(winner) : (raw ? mk(raw) : null);
}
