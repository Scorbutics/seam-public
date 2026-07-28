// THE FLOOR, read from the core. `seam-couple` owns the deterministic floor (the adapter scan, the
// const-resolved param sites and their merge); what remains in TypeScript is the LLM flywheel, and it needs
// to ask the floor two questions: "what does the whole repo ground?" and "what does THIS file ground?".
//
// Reading them from the addon rather than keeping a second TypeScript floor is the point: two floors that
// drift is exactly the failure this migration exists to remove — the flywheel would then learn against a
// floor the product does not use, and every "already grounded, skip it" decision would be made on the wrong
// evidence.
import { loadAddon } from "../rust_core.js";
import type { GroundingIndex, KeyHit } from "./types.js";

const core = () => {
  const a = loadAddon();
  if (!a) throw new Error("the Seam core (Rust addon) is not available — build it with `cargo build --release` in rust/");
  return a;
};

/// The merged floor index (`shared ⊕ param`) for the repo. Memoized in the core per repo.
export function floorIndex(repo: string): GroundingIndex {
  const idx: GroundingIndex = new Map();
  for (const [key, side, file, line] of core().floorIndex(repo) as string[][]) {
    if (!idx.has(key)) idx.set(key, { producers: [], consumers: [] });
    (side === "p" ? idx.get(key)!.producers : idx.get(key)!.consumers).push({ file, line: Number(line) });
  }
  return idx;
}

/// One file's floor keys — the per-file half, for deciding whether a file is floor-BLIND (and so worth an
/// LLM probe). Equal by construction to the repo pass's contribution for that file.
export function fileFloorKeys(file: string, text: string): KeyHit[] {
  return (core().scanFileKeys(file, text) as string[][]).map(([kind, value, line, produces, op, label, method, recv]) => {
    const h: KeyHit = { kind, value, line: Number(line), produces: produces === "true" };
    if (op) (h as any).op = op;
    if (label) (h as any).label = label;
    if (method) (h as any).method = method;
    if (recv) (h as any).recv = recv;
    return h;
  });
}
