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

import { loadAddon } from "../rust_core.js";

// THE RANKING IS THE CORE'S (`seam_grow::center::detect_centers`) — fan-in over the resolved graph, the
// undirected hop distance, and the `log2(1+fan) x relevance x proximity` score. Pinned by
// rust/parity/centers.ts: 720/720 over 90 real footprints, both the relevance path and the raw-fan-in
// degradation, at four (k, minFanIn) settings.
//
// RELEVANCE CROSSES AS ROWS, not as the callback it used to be. A function cannot cross napi, and the caller
// already holds the scores (it computes them for its own ranking), so re-deriving them inside the core would
// be a second embed pass over the same files. An EMPTY list means no intent field — the documented
// degradation to raw fan-in, not an error.
export function detectCenters(data: any, opts: CenterOpts = {}, k = 4): Center[] {
  const a = loadAddon();
  if (!a) throw new Error("the Seam core (Rust addon) is not available — build it with `cargo build --release` in rust/");
  const rows: string[][] = opts.relevance
    ? (data.nodes ?? []).map((n: any) => [`${n.symbol} ${n.file}`, String(opts.relevance!({ symbol: n.symbol, file: n.file }))])
    : [];
  const out = JSON.parse((a as any).growDetectCenters(
    JSON.stringify(data), rows, k, opts.minFanIn, opts.minRelevance,
    opts.excludeFile, opts.excludeSymbol, opts.anchorId)) as Center[];
  // The debug line stays shell-side: deciding what to LOG is the shell's job, and this one is read by a human
  // scanning why a concern picked the mechanism it did.
  if (opts.debug && out.length) opts.debug(`[concern] mechanisms: ${out.map((c) => `${c.symbol}(${c.fanIn})`).join(", ")}`);
  return out;
}

// Single-center convenience (the highest-ranked mechanism) — back-compat + the degenerate concern.
export function detectCenter(data: any, opts: CenterOpts = {}): Center | null {
  return detectCenters(data, opts, 1)[0] ?? null;
}
