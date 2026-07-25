// THE COUNTING-UNIT CONTRACT — the single place a set of cited members becomes a COUNT.
//
// Two structural shapes answer "who uses X" at two different GRAINS. `consumers` (grow/project_set.ts) projects
// every resolved in-EDGE, so one entry = one USAGE SITE and a caller touching the anchor on three lines
// contributes three. `contract` (grow/contract.ts) projects the MODULE graph, which materialises ONE consumer
// node per consuming FILE. Both are correct and neither is redundant — but each used to print a BARE integer for
// the same relationship (`resolved: 2127` next to `379 consumer(s)` for `packages/prisma/index.ts#prisma`), which
// a reader can only read as a contradiction, and which a grader can quote as if the two were interchangeable.
//
// So: every count of a member set is derived HERE, at all three grains, and the renderers NAME the grain they
// print. Lives in `core/` for exactly the reason `core/lines.ts` does — the convention must be shared by the
// GROW front (contract.ts's fan-in / per-export count) and the RENDER front (render/shapes.ts), and a second
// implementation on either side is how the two drift apart again.
export interface EdgeUnits {
  sites: number;    // one per projected entry (edge) — the finest grain
  symbols: number;  // distinct symbol-in-file
  files: number;    // distinct file — the module graph's grain
}

export function countUnits(items: { file: string; symbol?: string }[]): EdgeUnits {
  return {
    sites: items.length,
    symbols: new Set(items.map((i) => `${i.file}#${i.symbol ?? ""}`)).size,
    files: new Set(items.map((i) => i.file)).size,
  };
}

// Count + unit noun in one string, so a render can never print the number without the unit.
export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
