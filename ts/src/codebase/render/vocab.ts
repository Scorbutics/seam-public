// Shared render VOCABULARY for the flood/wave/scenario/agent/concern render family — one seam-rendering
// language (where/roles/facts/lineage/members) reused across every view instead of each view re-deriving it.
// CITATIONS go through `at` (render/shapes.ts) — the seam model's lines are 1-BASED (core/lines.ts) and a
// missing one must render as a bare path, never a fabricated `:0`/`:1`.
import { at } from "./shapes.js";
export type Hunk = { file?: string; role?: string; label?: string; enclosing?: string; kind?: string; start?: number; relevance?: number; spine?: boolean };
export type Seam = { id: string; label: string; tier?: string; selected?: boolean; suggested?: boolean;
  primary?: { file: string; line: number; symbol: string }; hunks?: Hunk[];
  culmination?: number; writes?: string[]; dir?: string;
  lineage?: { sha: string; subject: string; author: string; date: string } };
export type Ranked = { id: string; label: string; score: number; tier?: string; writes?: string[]; dir?: string | null };

export const rolesOf = (s: Seam): string => {
  const r = [...new Set((s.hunks ?? []).map((h) => h.role).filter(Boolean))];
  return r.length ? r.join(",") : "—";
};
export const filesOf = (s: Seam): string[] => [...new Set((s.hunks ?? []).map((h) => h.file).filter(Boolean) as string[])];
// The file's container stem (Java: one public class per file = the class; elsewhere the module/file name). Used
// to QUALIFY a bare method name so two same-named methods in different classes are distinguishable at a glance
// (the acme case: BookingsBean.createBooking vs AcmeCheckBookingsService.createBooking). Only when it
// adds information (≠ the symbol, so a class node `BookingsBean` isn't rendered `BookingsBean.BookingsBean`).
export const _container = (f?: string): string => (f ? (f.split("/").pop() ?? f).replace(/\.[^.]+$/, "") : "");
export const where = (s: Seam): string => {
  if (!s.primary) return filesOf(s)[0] ?? "—";
  const c = _container(s.primary.file);
  const qualified = c && c !== s.primary.symbol ? `${c}.${s.primary.symbol}` : s.primary.symbol;
  return `${qualified} (${at(s.primary.file, s.primary.line)})`;
};
export const facts = (s: Seam): string => {
  const bits: string[] = [];
  if (s.writes && s.writes.length) bits.push(`writes ${s.writes.join(", ")}`);
  if (s.dir) bits.push(s.dir === "backward" ? "downstream" : "upstream entry");
  return bits.length ? `  {${bits.join("; ")}}` : "";
};
// git lineage — the deterministic "why" (last-touching commit). Shown inline so an LLM reads provenance
// it can trust alongside the code location.
export const lineageOf = (s: any): string => s.lineage ? `  ↳ ${s.lineage.sha} "${s.lineage.subject}" (${s.lineage.author}, ${s.lineage.date})` : "";

// The MEMBERS to read first inside a seam — the spine the structural floor collapsed into one blob. Without
// these a tangled (god-object / DI) seam renders as one near-empty line; with them the reader sees WHICH of
// the N members carry the flow. Only the `spine`-flagged members, NEAREST THE ANCHOR FIRST, capped.
//
// Ordered by hop distance, not by cosine. Measured against what agents actually open (`bench/ranking/`), the
// cosine order put 3-6% of read demand in a top-12 against 24-54% for hop distance, and ties inside a hop
// band came out identical however they were broken — so `hops` decides and relevance is shown, not obeyed.
// Falls back to relevance order when the grow carried no intent and so computed no distances.
const _MEMBER_CAP = 8;
export const memberLines = (s: Seam): string[] => {
  const sp = (s.hunks ?? []).filter((h) => h.spine && typeof h.relevance === "number")
    .sort((a, b) => {
      const ha = typeof (a as any).hops === "number" ? (a as any).hops : Infinity;
      const hb = typeof (b as any).hops === "number" ? (b as any).hops : Infinity;
      return (ha - hb) || (b.relevance! - a.relevance!);
    }).slice(0, _MEMBER_CAP);
  return sp.map((h) => {
    const hp = typeof (h as any).hops === "number" ? `[${(h as any).hops}] ` : "";
    return `     ★ ${hp}${h.relevance!.toFixed(2)} ${h.label ?? "?"}${h.file ? ` (${at(h.file, h.start)})` : ""}`;
  });
};

// A seam's WAVE SHELL — hops from the anchor (the flood's own bookkeeping). Shared by the region/wave/
// scenario views and the agent spine (which needs it for its own shell ordering).
export const _shellOf = (s: Seam): number => ((s as any).region?.shell ?? -1);

// The per-NODE (hunk-id) index every render view rebuilds by hand: id -> its owning seam, its raw hunk, and
// its display label (the hunk's own label, falling back to the seam's when a hunk carries none — a seam-level
// synthetic node). renderAgent and renderConcern each used to walk
// `for (const s of seams) for (const h of s.hunks ?? [])` independently to build their own shape of this same
// index; this is the one shared traversal, callers derive whatever narrower shape (hunkById/seamOfId/label
// maps, …) they want from it.
export interface NodeInfo { seam: Seam; hunk: Hunk; label: string }
export function buildNodeIndex(seams: Seam[]): Map<string, NodeInfo> {
  const index = new Map<string, NodeInfo>();
  for (const s of seams) for (const h of (s.hunks ?? [])) {
    const id = (h as any).id;
    if (id != null) index.set(String(id), { seam: s, hunk: h, label: h.label ?? s.label });
  }
  return index;
}
