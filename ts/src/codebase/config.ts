// Seam-assembly / RENDER tunables used by codebase.ts (the decompose core) — centralized knobs that
// shape the emitted seam map. Values identical to the inlined literals they replaced.
export const RENDER = {
  fanCap: 8,             // a seam with more inline call-sites than this is a guard/policy fan → cap + summarize
  offCap: 8,             // max OFF-tier seams shown before collapsing the rest
  terminalCap: 12,       // max terminals surfaced
  blindspotCap: 50,      // max blindspots emitted
  policyMinConsumers: 8, // a wide import-only fan with ≥ this many consumers reads as a policy, not a flow
};
