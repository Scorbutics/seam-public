// CONCERN CENTER detection (deterministic, structural). A "concern" question ("how are bookings managed?") has
// no entry point — it has a shared MECHANISM (a bean / service / table) that every interaction delegates through.
// That mechanism is the node with the highest FAN-IN (most distinct consumers) in the intent-scoped region: on
// Acme, the `BookingsBean` all the admin/member/API/job paths call. This is a STRUCTURAL fact (in-degree
// over the resolved graph), not a name guess — the intent already scoped the region via the grow, so the
// most-consumed node in it IS the concern's center. Feeds the re-anchor: grow FROM the center → the star of
// interactions, robustly, no matter which point the auto-anchor happened to land on.
export interface Center { id: string; file: string; symbol: string; fanIn: number; }

// `relevance(file)` — the intent-field score of a file (embeddings), when available. WITHOUT it the highest-fan-in
// node wins outright, which on a real app is a UBIQUITOUS ENTITY (`User`, referenced by everything — fan-in 61),
// NOT the concern's mechanism (`BookingsBean`, fan-in 14). So we FILTER to on-intent nodes first: `User` scores
// off-intent for "how are bookings managed" and is excluded; among the on-intent survivors the highest fan-in is
// the center. Degrades to raw fan-in when no relevance is passed or nothing clears the floor (I5).
export function detectCenter(data: any, opts: { minFanIn?: number; excludeFile?: string; excludeSymbol?: string; relevance?: (file: string) => number; minRelevance?: number } = {}): Center | null {
  const minFanIn = opts.minFanIn ?? 2;
  const minRel = opts.minRelevance ?? 0.18;
  const byId = new Map<string, any>((data.nodes ?? []).map((n: any) => [n.id, n]));
  const callers = new Map<string, Set<string>>();   // DISTINCT consumers per node, ignoring containment edges
  for (const e of data.edges ?? []) {
    if (e.kind === "contains") continue;
    (callers.get(e.to) ?? callers.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const pick = (onIntentOnly: boolean): Center | null => {
    let best: any = null, bestFan = 0;
    for (const [id, set] of callers) {
      const n = byId.get(id);
      if (!n || !n.file || !n.symbol) continue;                                 // must be a real symbol we can re-anchor on
      if (n.file === opts.excludeFile && n.symbol === opts.excludeSymbol) continue;
      if (onIntentOnly && opts.relevance && opts.relevance(n.file) < minRel) continue;   // off-intent hub (User) → excluded
      const fan = set.size;
      if (fan > bestFan || (fan === bestFan && (n.complexity ?? 0) > (best?.complexity ?? 0))) { best = n; bestFan = fan; }
    }
    return best && bestFan >= minFanIn ? { id: best.id, file: best.file, symbol: best.symbol, fanIn: bestFan } : null;
  };
  // prefer the on-intent center; fall back to raw fan-in only if the intent filter left nothing (or no relevance).
  return (opts.relevance ? pick(true) : null) ?? pick(false);
}
