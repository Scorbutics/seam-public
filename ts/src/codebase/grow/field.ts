// REGION-CENTROID FIELD math — pure and embedding-agnostic (it operates on already-computed vectors), so
// it is unit-testable offline with synthetic vectors. A running WEIGHTED centroid of the kept region plus
// the cosine of a candidate to the centroid's unit direction. The grow border (orchestrate `centroid` /
// `blend` field) accumulates the region's def vectors here and scores candidates against it — arithmetic
// over cached vectors, no new embedding work (I7: one field for the existing soft border, not a 2nd walker).
export function cosine(a: number[], b: number[]): number {
  let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s;
}

export class RegionCentroid {
  private sum: number[] | null = null;
  private w = 0;

  // fold a kept node's vector into the running centroid with a weight (anchor / wave-1 keeps weigh ×2).
  add(vec: number[] | undefined, weight: number): void {
    if (!vec || weight <= 0) return;
    if (!this.sum) this.sum = new Array(vec.length).fill(0);
    const s = this.sum;
    for (let i = 0; i < vec.length && i < s.length; i++) s[i] += vec[i] * weight;
    this.w += weight;
  }

  // the centroid direction as a UNIT vector (so a candidate's cosine to it is on the same 0..1 scale as the
  // intent cosine the border already uses), or null when nothing has been folded in yet.
  unit(): number[] | null {
    if (!this.sum || this.w === 0) return null;
    const m = this.sum.map((x) => x / this.w);
    let nrm = 0; for (const x of m) nrm += x * x; nrm = Math.sqrt(nrm);
    return nrm > 0 ? m.map((x) => x / nrm) : null;
  }

  // cosine of a candidate vector to the current centroid direction (0 when either is absent → the border
  // degrades to a flood exactly as it does when embeddings are absent, I3).
  score(vec: number[] | undefined): number {
    const c = this.unit(); if (!c || !vec) return 0;
    return cosine(c, vec);
  }
}
