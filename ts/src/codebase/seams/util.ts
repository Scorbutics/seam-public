// Tiny set/ranking helpers shared across the seam-assembly passes (roles, clustering, LLM tiering).
export const intersect = (a: Set<string>, b: Set<string> | undefined): Set<string> => {
  const out = new Set<string>();
  if (b) for (const x of a) if (b.has(x)) out.add(x);
  return out;
};
export const maxBy = <T>(arr: T[], key: (x: T) => number): T => arr.reduce((a, b) => (key(b) > key(a) ? b : a));
export const dedup = (a: string[]): string[] => [...new Set(a)];
