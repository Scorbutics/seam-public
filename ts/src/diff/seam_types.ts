// The seam-assembly data-shapes (a leaf module). Lives apart from seams.ts so that subgroup.ts —
// the altitude sub-grouping that seams.ts CALLS — can name these types without importing seams.ts
// back (which created a seams↔subgroup cycle). seams.ts owns the LOGIC; this owns the SHAPES.
export interface Block {
  role: string; key: string; hid: string; file: string; start: number; end: number;
  has_diff: boolean; items: any[]; files: string[]; whys: string[]; notes: string[]; count: number;
  // Intra-seam "closeness": for a link block in a MULTI-core seam, the specific core(s) it
  // wires (resolved by shared distinctive symbols). Empty/absent = single-core seam (the pill
  // would be redundant) or a link with no symbol-grounded core target (an honest "no target").
  wires?: { file: string; start: number }[];
}
export interface SeamDict {
  tested: boolean; untested: boolean; id: string; label: string; blocks: Block[];
  has_core: boolean; has_link: boolean; verification: any; count: number; link_ids: string[];
  uncertain: boolean; confidence: number; shares_with?: string[];
}
export interface ClusterDict {
  id: string; intent: string; seams: SeamDict[]; n_seams: number;
  role_pills: { role: string; count: number }[]; count: number; warnings: any[];
}
