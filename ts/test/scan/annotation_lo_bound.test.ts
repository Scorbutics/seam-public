// _annotationLo widens a node's key-scan window UP over leading @annotations/blank lines. Its start index is
// `lo - 1`, and `lo` can point PAST the end of the text we re-read (a stale/mismatched range after an edit, or a
// coupling probe on a file whose ranges came from a different read). An unbounded `lines[lo-1].trim()` then threw
// on `undefined`, and because the merged concern grow swallows the error in a `.catch`, the WHOLE grow silently
// produced nothing (private-app: "how are bookings persisted" returned an empty footprint). This pins the bound: an
// out-of-range `lo` clamps to the last line instead of throwing.
import { describe, expect, test } from "bun:test";
import { _annotationLo } from "../../src/codebase/scan/attach.js";

describe("_annotationLo — line index is bounded to the file (out-of-range lo must not throw)", () => {
  const text = "x\n@Deco\nclass Foo {}\n";   // ["x","@Deco","class Foo {}",""]

  test("lo far past EOF clamps to the last line without throwing", () => {
    expect(() => _annotationLo(text, 9999)).not.toThrow();
    expect(_annotationLo(text, 9999)).toBe(text.split("\n").length - 1);   // clamped, not a crash
  });

  test("normal in-range lo still widens up over the leading @annotation", () => {
    expect(_annotationLo(text, 2)).toBe(1);   // scans up from the class line over `@Deco`
  });

  test("lo with no leading annotation is a no-op (window starts at lo)", () => {
    expect(_annotationLo("x\ny\nclass Foo {}\n", 2)).toBe(2);
  });
});
