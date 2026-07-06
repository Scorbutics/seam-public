// GROW phase — public API. Expand a footprint outward from the anchor to its terminals (deterministic),
// plus subject-affinity recall of intent-related-but-unreachable seams.
export { grow_to_terminals, grow_footprint_scoped, grow_centers_scoped } from "./orchestrate.js";
export { subject_affinity, affinity_grow, type AffinityHit, type AffinityResult } from "./subject_affinity.js";
