// emit (SeamModel) — a VIEW over the core's `seam_decompose::emit`.
//
// The model assembly lives in Rust now: hunk shape, core-grouped ordering, the caller-fan cap, the
// (file,span) dedup, the seam representative, region metadata, the structural-spine lock, seam contracts,
// the blindspot roll-up, and the frontier cap. What stays here is the wire and the git-lineage attachment.
//
// THE LINE CONTRACT still holds and still happens exactly once: the Graph IR is 0-BASED (the detect passes
// slice files with `node.start/end` as row indices), and the core shifts to 1-based at this boundary. An
// UNLOCATED node keeps its [0,0] sentinel — 0 means "no line", and `:1` would be a fabricated citation.
import { type Graph } from "../../core/graph_ir.js";
import { loadAddon } from "../rust_core.js";
import { type Seam } from "./clusters.js";
import { core, toWire, seamsToCore } from "./wire.js";

// `wellformedness` returns JS Maps. They cross as ROWS, not as objects: an object would lose the ordering,
// and for numeric-looking node ids `JSON.stringify` would hoist those keys to the front.
const healthWire = (health: any): string => JSON.stringify({
  seam_warnings: [...(health?.seam_warnings ?? new Map())].map(([k, v]) => [k, v]),
  node_warnings: [...(health?.node_warnings ?? new Map())].map(([k, v]) => [k, v]),
  postures: health?.postures ?? {},
});

export function emit_seams(g: Graph, health: any, seams: Seam[],
    opts: { shape?: "policy" | "flow"; lead?: "backward" | "forward" | "both"; lineageRepo?: string; intent?: boolean } = {}): any {
  const res = JSON.parse(core().decomposeEmitSeams(
    toWire(g), healthWire(health), seamsToCore(seams),
    JSON.stringify({ intent: Boolean(opts.intent), ...(opts.shape ? { shape: opts.shape } : {}), ...(opts.lead ? { lead: opts.lead } : {}) }),
  ));
  const model = res.model;

  // THE SPINE LOCK IS A MUTATION OF THE CALLER'S SEAMS, not only of the emitted copies — `_spine_order` and
  // the embedding banding both read `seam.tier` off the objects passed in here, and the whole point of the
  // lock is that the topology-decided spine survives a later re-band. The core returns which ids it locked
  // rather than performing it invisibly, so this stays one explicit line instead of a side effect a reader
  // has to infer from the fact that emit takes a mutable array.
  const locked = new Set<string>(res.spineLocked ?? []);
  if (locked.size) for (const s of seams) if (locked.has(s.id)) s.tier = "spine";

  // GIT LINEAGE (opt-in, additive): the last-touching commit of each seam's primary file — the "why" layer,
  // deterministic (git ground truth). Applied here rather than in the core because it is the one part of
  // emit that does I/O, and it is conditional on `lineageRepo`, which the oracle fixtures never set.
  if (opts.lineageRepo) {
    const files = model.clusters.flatMap((c: any) => c.seams.map((s: any) => s.primary?.file)).filter(Boolean);
    if (files.length) {
      // `[file, sha, subject, author, date]` rows; an absent row means git could not resolve the file, and
      // absent is what the caller wants — no lineage rather than a blank one.
      const rows = (loadAddon()?.gitLineage(opts.lineageRepo, files) ?? []) as string[][];
      const lin = new Map(rows.map(([file, sha, subject, author, date]) => [file, { sha, subject, author, date }]));
      for (const c of model.clusters) for (const s of c.seams) { const l = s.primary && lin.get(s.primary.file); if (l) s.lineage = l; }
    }
  }
  return model;
}
