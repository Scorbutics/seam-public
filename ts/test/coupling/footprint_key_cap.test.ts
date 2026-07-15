// FOOTPRINT-MEMBERSHIP prioritisation in the per-node key cap. A coupling node's span is the WHOLE file, so one
// node surfaces every method's boundary key; when there are more than `nodeKeyCap`, the cap must keep the keys of
// the methods the grow REACHED over unreached siblings. Without this, a deterministic tiebreak (fanout, then
// alphabetical) can keep a sibling's key and surface the WRONG backend — the kc_3 `create` (base route
// `/admin/realms/*/users`) buried under 78 sibling routes. This tests the deterministic ordering directly.
import { describe, expect, test } from "bun:test";
import { _footprintRank, _orderKeysByFootprint } from "../../src/codebase/coupling/index.js";

describe("_footprintRank", () => {
  test("a line inside a reached method's range ranks 0 (first); outside ranks 1", () => {
    const ranges: [number, number][] = [[40, 55], [95, 110]];
    expect(_footprintRank(ranges, 47)).toBe(0);   // in the first reached method
    expect(_footprintRank(ranges, 99)).toBe(0);   // in the second
    expect(_footprintRank(ranges, 470)).toBe(1);  // an unreached sibling far below
    expect(_footprintRank([], 47)).toBe(1);       // no footprint info → everything is "outside"
  });
});

describe("_orderKeysByFootprint — reached methods win the cap", () => {
  test("a REACHED method's key outranks a sibling that would otherwise win by fanout AND alphabetical order", () => {
    // `create` is REACHED (line 47, in range) but would lose both tiebreaks: it has HIGHER fanout (3 vs 1) and a
    // LATER value than the two unreached siblings. Footprint membership must still float it to the front.
    const keys = [
      { value: "/aaa", line: 470, fanout: 1 },                  // unreached, wins fanout + alpha
      { value: "/bbb", line: 480, fanout: 1 },                  // unreached
      { value: "/admin/realms/*/users", line: 47, fanout: 3 },  // REACHED (create) — worse on both tiebreaks
    ];
    const ordered = _orderKeysByFootprint(keys, [[40, 55]]);
    expect(ordered[0].value).toBe("/admin/realms/*/users");     // cap=1 would now keep the reached route
  });

  test("among reached keys, the usual tiebreaks (fanout, then value) still apply", () => {
    const keys = [
      { value: "/z", line: 45, fanout: 2 },   // reached
      { value: "/a", line: 46, fanout: 1 },   // reached, lower fanout → first
      { value: "/out", line: 999, fanout: 1 },// unreached → last
    ];
    const ordered = _orderKeysByFootprint(keys, [[40, 55]]);
    expect(ordered.map((k) => k.value)).toEqual(["/a", "/z", "/out"]);
  });

  test("with no footprint ranges it degrades to fanout-then-value (unchanged legacy order)", () => {
    const keys = [
      { value: "/b", line: 10, fanout: 2 },
      { value: "/a", line: 20, fanout: 1 },
    ];
    expect(_orderKeysByFootprint(keys, []).map((k) => k.value)).toEqual(["/a", "/b"]);   // lowest fanout first
  });
});
