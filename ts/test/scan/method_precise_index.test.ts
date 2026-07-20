// methodPreciseIndex — the serializable {units, calls} artifact the fan's method-precise rehydration disk-caches
// (cachedMPIndex) to skip the tree-sitter parse on warm grows. REGRESSION: the call-site map is a plain object, so
// a callee named `toString`/`constructor`/`valueOf` (real Java calls `toString()` everywhere) reads a TRUTHY
// Object.prototype member → `calls[name] ??= []` skips the array init → `.push` throws "not a function" (crashed
// EVERY Java coupling grow; private-app/TS + the fixtures happened not to call those names, so it slipped the suite). The
// fix is a null-prototype `calls` object here + an Array.isArray guard on the read side. Gated on tree-sitter.
import { describe, expect, test } from "bun:test";
import { makeCtx, available } from "../../src/codebase/atoms.js";
import { methodPreciseIndex } from "../../src/codebase/scan/ast_units.js";

describe("methodPreciseIndex", () => {
  test("a callee named toString/hashCode (Object.prototype collision) doesn't crash the call-site index", async () => {
    if (!available()) return;
    // BARE (receiver-less) calls to prototype-named methods — the case _call_lines/methodPreciseIndex indexes
    // (first child IS the callee identifier), and exactly what crashed on real Java (`toString()` implicit-this).
    const src = `package m;
public class A {
  public String go(){ return toString() + build() + toString(); }
  public Object build(){ return new Object(); }
}
`;
    const ctx = await makeCtx(src, "java");
    if (!ctx) return;   // java grammar unavailable (offline .vsix) → skip
    const idx = methodPreciseIndex(ctx);                          // must NOT throw (the bug)
    expect(Array.isArray(idx.units)).toBe(true);
    expect(idx.units.some((u) => u[0] === "go")).toBe(true);      // real method units present
    // the prototype-colliding callee is recorded as a real array of call lines, not the inherited function
    expect(Array.isArray(idx.calls["toString"])).toBe(true);
    expect(idx.calls["toString"].length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(idx.calls["build"])).toBe(true);        // an ordinary callee still resolves
  });
});
