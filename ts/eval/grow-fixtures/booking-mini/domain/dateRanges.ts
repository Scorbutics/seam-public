// Pure interval arithmetic — merge overlapping numeric ranges. Shares NO vocabulary with booking or
// availability, yet the availability mechanism delegates its core computation here. A pure-embedding
// intent border scores this near-zero and cuts it; it must be KEPT (it is on the mechanism path).
export function mergeIntervals(ranges: number[][]): number[][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: number[][] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}
