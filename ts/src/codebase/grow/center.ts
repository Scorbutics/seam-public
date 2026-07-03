// CONCERN CENTER detection (deterministic, structural). A "concern" question ("how are bookings managed?") has
// no entry point — it has a shared MECHANISM (a bean / service / table) that every interaction delegates through.
// That mechanism is the node with the highest FAN-IN (most distinct consumers) in the intent-scoped region: on
// Acme, the `BookingsBean` all the admin/member/API/job paths call. This is a STRUCTURAL fact (in-degree
// over the resolved graph), not a name guess — the intent already scoped the region via the grow, so the
// most-consumed node in it IS the concern's center. Feeds the re-anchor: grow FROM the center → the star of
// interactions, robustly, no matter which point the auto-anchor happened to land on.
export interface Center { id: string; file: string; symbol: string; fanIn: number; }

export function detectCenter(data: any, opts: { minFanIn?: number; excludeFile?: string; excludeSymbol?: string } = {}): Center | null {
  const minFanIn = opts.minFanIn ?? 2;
  const byId = new Map<string, any>((data.nodes ?? []).map((n: any) => [n.id, n]));
  // DISTINCT consumers per node (a caller with several call-sites counts once), ignoring containment edges.
  const callers = new Map<string, Set<string>>();
  for (const e of data.edges ?? []) {
    if (e.kind === "contains") continue;
    (callers.get(e.to) ?? callers.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  let best: any = null, bestFan = 0;
  for (const [id, set] of callers) {
    const n = byId.get(id);
    if (!n || !n.file || !n.symbol) continue;                                   // must be a real symbol we can re-anchor on
    if (n.file === opts.excludeFile && n.symbol === opts.excludeSymbol) continue;
    const fan = set.size;
    if (fan > bestFan || (fan === bestFan && (n.complexity ?? 0) > (best?.complexity ?? 0))) { best = n; bestFan = fan; }
  }
  if (!best || bestFan < minFanIn) return null;   // no shared mechanism → not a concern shape (caller falls back honestly)
  return { id: best.id, file: best.file, symbol: best.symbol, fanIn: bestFan };
}
