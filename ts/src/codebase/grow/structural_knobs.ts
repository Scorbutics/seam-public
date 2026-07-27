// STRUCTURAL CONTAINMENT KNOBS — the ONE place the grow's containment configuration is resolved.
//
// The grow has two engines now (the TS wave in orchestrate.ts and the Rust core behind the napi boundary), and
// they must produce the SAME graph for the same call. Configuration is where that guarantee is cheapest to
// lose: the Rust port hard-coded `HUB_FAN`/`UP_HOP_STRUCTURAL`/`Exclusion::new(&[], false)` while the TS path
// honoured `opts.hubFan`/`opts.upHop`/`opts.excludeDirs`, so `--exclude` and `includeTests` were silently
// ignored by one engine and respected by the other — an A/B that returned byte-identical results for opposite
// flags. Resolving opts→env→default HERE, once, and handing both engines the finished VALUES makes that class
// of drift unrepresentable: Rust holds no defaulting logic at all (see WaveOpts).
//
// Only the knobs that survive a STRUCTURAL grow live here. The intent-field knobs (borderField/borderTol/
// tierMargin) are deliberately absent: under `structuralGrow` the embedding field is never built, so they are
// dead by construction (CLAUDE.md — the grow is intent-free), and carrying them across the boundary would
// advertise a capability the Rust core does not have.

const _flag = (v: string | undefined): boolean | undefined => (v === undefined || v === "") ? undefined : (v === "1" || v === "true");
const _int = (v: string | undefined, d: number): number => (parseInt(v ?? String(d), 10) || d);

export type StructuralKnobs = {
  maxSteps: number; maxNodes: number;
  hubGate: boolean; hubFan: number; hubCollapse: boolean; hubUbiquity: number; hubTypeFan: number;
  ubiquity: boolean; ubiquityFan: number;
  upHop: number; complementUpHop: number;
  couplingHubContain: boolean;
  excludeDirs: string[]; includeTests: boolean;
  intent?: string; structuralGrow: boolean;
  borderTol?: number; borderField: string; tierGrow: boolean; tierMargin?: number;
};

export type KnobOpts = {
  maxSteps?: number; maxNodes?: number;
  hubGate?: boolean; hubFan?: number; hubCollapse?: boolean; hubUbiquity?: number; hubTypeFan?: number;
  ubiquity?: boolean; ubiquityFan?: number; upHop?: number;
  excludeDirs?: string[]; includeTests?: boolean;
  dataCoupling?: boolean; structuralGrow?: boolean;
  intent?: string; borderTol?: number | null; borderField?: string; tierGrow?: boolean; tierMargin?: number;
};

// `stableFloor` is the footprint-scoping PROBE (grow_footprint_scoped), which discards its footprint and only
// keeps the files it reached — so it stays inclusive, except that hub-collapse remains ON (a mega-hub's fan is
// off-spine sibling code, never coupling-relevant, and the I4 invariant already protects crossing-bearers).
export function resolveStructuralKnobs(opts: KnobOpts = {}, stableFloor = false, probeInclusive = false): StructuralKnobs {
  const hubCollapse = (opts.hubCollapse ?? _flag(process.env.SEAM_HUB_COLLAPSE) ?? true) && !(stableFloor && probeInclusive);
  return {
    maxSteps: opts.maxSteps ?? 12,
    maxNodes: opts.maxNodes ?? 80,
    hubCollapse,
    // hubGate/ubiquity only matter when hubCollapse is explicitly off — collapse subsumes both (one mechanism).
    hubGate: (opts.hubGate ?? false) || hubCollapse,
    ubiquity: (opts.ubiquity ?? true) || hubCollapse,
    hubFan: Math.max(2, opts.hubFan ?? _int(process.env.SEAM_HUB_FAN, 12)),
    hubUbiquity: Math.max(2, opts.hubUbiquity ?? _int(process.env.SEAM_HUB_UBIQUITY, 12)),
    hubTypeFan: Math.max(2, opts.hubTypeFan ?? _int(process.env.SEAM_HUB_TYPE_FAN, 5)),
    ubiquityFan: Math.max(2, opts.ubiquityFan ?? _int(process.env.SEAM_UBIQUITY_FAN, 12)),
    // 0 = off. A STRUCTURAL grow defaults K=2: with the intent field absent it is the SOLE container.
    upHop: Math.max(0, opts.upHop ?? (opts.structuralGrow ? 2 : _int(process.env.SEAM_UP_HOP, 0))),
    // Unset → 1; a non-numeric value → 0 (off), matching the original `parseInt(env ?? "1", 10) || 0`.
    complementUpHop: Math.max(0, parseInt(process.env.SEAM_COMPLEMENT_UP_HOP ?? "1", 10) || 0),
    // Inert unless coupling is on (the sink set is built from db-table crossing edges) — I1.
    couplingHubContain: process.env.SEAM_COUPLING_HUB_CONTAIN !== "0" && opts.dataCoupling !== false,
    excludeDirs: opts.excludeDirs ?? [],
    includeTests: !!opts.includeTests,
    // THE INTENT KNOBS. Resolved HERE like every other knob so the two engines cannot disagree about what one
    // means — the Rust core holds no defaulting logic. Absent intent (or a structural grow) makes the addon's
    // field inert, which is the same degradation the TS wave has when embeddings are unavailable.
    intent: opts.structuralGrow ? undefined : opts.intent,
    structuralGrow: !!opts.structuralGrow,
    borderTol: opts.borderTol ?? (process.env.SEAM_GROW_BORDER_TOL ? parseFloat(process.env.SEAM_GROW_BORDER_TOL) : undefined),
    borderField: opts.borderField ?? process.env.SEAM_GROW_BORDER_FIELD ?? "",
    tierGrow: (opts.tierGrow ?? _flag(process.env.SEAM_TIER_GROW) ?? true) && !stableFloor,
    tierMargin: opts.tierMargin ?? (process.env.SEAM_TIER_MARGIN ? parseFloat(process.env.SEAM_TIER_MARGIN) : undefined),
  };
}
