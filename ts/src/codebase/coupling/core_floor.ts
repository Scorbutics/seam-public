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

/// The COMPOSED-ROUTE index — sub-resource handlers whose full path the core composed from their cross-file
/// mount chain, replayed from `.seam`.
export function composedRoutesIndex(repo: string): GroundingIndex {
  const idx: GroundingIndex = new Map();
  for (const [key, side, file, line] of core().composedRoutesIndex(repo) as string[][]) {
    if (!idx.has(key)) idx.set(key, { producers: [], consumers: [] });
    (side === "p" ? idx.get(key)!.producers : idx.get(key)!.consumers).push({ file, line: Number(line) });
  }
  return idx;
}

/// STRUCTURAL pre-clustering of floor-blind files — which of them share a data-access SHAPE, so the model
/// reads ONE representative and the rest ground via the learned rule.
///
/// Reading this from the core matters more than the other shims here: the REPRESENTATIVE decides which file
/// the model actually sees. Two clusterers disagreeing would have the flywheel learn a rule off one file and
/// claim it grounds another — a wrong answer, not a missing one.
///
/// The addon returns INDICES into the input (the napi boundary carries no object identity), rehydrated here.
export interface BlindCluster<T> { signature: string; shaped: boolean; rep: T; members: T[] }
export function clusterBlindFiles<T extends { file: string; text: string }>(files: T[]): BlindCluster<T>[] {
  const rows = files.map((f) => [f.file, f.text]);
  return (core().clusterBlindFiles(rows) as { signature: string; shaped: boolean; rep: number; members: number[] }[])
    .map((c) => ({ signature: c.signature, shaped: c.shaped, rep: files[c.rep], members: c.members.map((i) => files[i]) }));
}

/// The two CLASSIFICATION teachers — receivers (`userRepository` is a database, `axios` is an http client)
/// and annotations (a project's own `@GlobexRoute` is a route). Both persist their learned matchers into
/// `.seam` and return how many they minted; the caller replays them from the store, so nothing crosses back
/// but a count. Served by the caller's model through the host bus when one is installed.
export const classifyReceivers = (repo: string, model?: string, claudeBin?: string): number =>
  core().classifyReceivers(repo, model, claudeBin);
export const classifyAnnotations = (repo: string, model?: string, claudeBin?: string): number =>
  core().classifyAnnotations(repo, model, claudeBin);
