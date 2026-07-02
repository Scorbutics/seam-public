// REGION-CENTROID FIELD math — the pure primitive behind the grow's `centroid`/`blend` border. Tested
// hermetically with SYNTHETIC vectors (no embeddings, no repo), so it runs everywhere. It pins: the
// weighted running centroid, the unit-normalised direction (so a candidate's cosine is on the intent
// scale), the ×2 drift-control weighting, and the degradation contract (empty → 0 → the border floods).
import { describe, expect, test } from "bun:test";
import { RegionCentroid, cosine } from "../../src/codebase/grow/field.js";

describe("RegionCentroid — weighted running centroid + cosine", () => {
  test("cosine of unit vectors", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  test("empty centroid scores 0 (degradation — the border floods, I3)", () => {
    const c = new RegionCentroid();
    expect(c.unit()).toBeNull();
    expect(c.score([1, 0])).toBe(0);
    c.add(undefined, 2);        // no vector → still empty
    expect(c.unit()).toBeNull();
    expect(c.score([1, 0])).toBe(0);
  });

  test("a candidate near the folded region scores higher than one orthogonal to it", () => {
    const c = new RegionCentroid();
    c.add([1, 0, 0], 1);
    c.add([0.8, 0.2, 0], 1);   // both roughly along x
    const unit = c.unit()!;
    expect(unit.length).toBe(3);
    expect(cosine(unit, unit)).toBeCloseTo(1, 6);   // unit-normalised
    expect(c.score([1, 0, 0])).toBeGreaterThan(c.score([0, 1, 0]));
  });

  test("weighting shifts the centroid toward the heavier vector (drift control)", () => {
    const heavy = new RegionCentroid();
    heavy.add([1, 0], 2);      // anchor / wave-1 ×2
    heavy.add([0, 1], 1);
    const even = new RegionCentroid();
    even.add([1, 0], 1);
    even.add([0, 1], 1);
    // the ×2 on [1,0] pulls the centroid closer to x than the even blend does.
    expect(heavy.score([1, 0])).toBeGreaterThan(even.score([1, 0]));
    expect(even.score([1, 0])).toBeCloseTo(even.score([0, 1]), 6);   // even → symmetric
  });
});
