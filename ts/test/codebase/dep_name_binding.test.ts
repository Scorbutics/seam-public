// WHICH DEFINITION A BARE NAME IN THE ANCHOR BODY POINTS AT — the two ways the dependency pass got this wrong,
// both found by the grep-vs-Seam benchmark on cal.com (`bench/grep-vs-seam`, run 1) rather than by a unit test,
// and both invisible to the CLI snapshot gate because the gate's fixtures have no name collision and no
// const-bound export.
//
// They compound, which is why they are pinned together: on the real file the anchor got a CONFIDENT WRONG edge
// (the same-named class method) and NO edge to the thing it actually calls (the const-bound import). A reader
// following the map landed on a two-line wrapper and never saw the prisma transaction. That inverts the whole
// precision claim — grep would have surfaced BOTH candidates and let the reader disambiguate; Seam picked one,
// silently.
//
// The fixtures mirror cal.com's `RegularBookingService.ts` shape exactly, minimised:
//   - a module-scope `import { createBooking }` AND a class method of the same name in the same file
//   - the imported symbol exported as `export const createBooking = withReporting(_createBooking, …)`
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_dependency_graph } from "../helpers/scan.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

/** The anchor's direct dependency edges as `symbol@file:startLine` — the grain the defects are about. */
const depsOf = async (file: string, symbol: string): Promise<string[]> => {
  const g = await build_dependency_graph(REPO, file, symbol, { dataCoupling: false });
  const byId = new Map<string, any>(g.nodes.map((n: any) => [n.id, n]));
  return g.edges
    .filter((e: any) => e.from === g.anchor.id && e.to !== g.anchor.id)
    .map((e: any) => byId.get(e.to))
    .filter(Boolean)
    .map((n: any) => `${n.symbol}@${n.file}:${n.range[0]}`)
    .sort();
};

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "depbind-"));
  writeFileSync(join(REPO, "package.json"), `{ "name": "depbind", "version": "1.0.0" }`);

  // The real implementation is `_createBooking`; the EXPORTED name is a wrapper call over it. `named_units`
  // models no `const` binding, so before the fix this file had nothing addressable named `createBooking`.
  w("src/createBooking.ts", `function withReporting<T>(fn: T, _name: string): T { return fn; }

const _createBooking = async (input: { uid: string }) => {
  return prismaTransaction(input);   // the same-file callee the ANCHOR test below looks for
};

function prismaTransaction(i: { uid: string }) { return { id: 1, uid: i.uid }; }

export const createBooking = withReporting(_createBooking, "createBooking");
`);

  // `handler` calls the IMPORT. `RegularBookingService.createBooking` merely shares the name — a method is not
  // a module binding, so the two coexist meaning different things.
  w("src/service.ts", `import { createBooking } from "./createBooking";

export async function handler(uid: string) {
  const booking = await createBooking({ uid });
  return booking;
}

export class RegularBookingService {
  async createBooking(input: { uid: string }) {
    return handler(input.uid);
  }
}
`);

  // The FALSIFICATION fixture: same file shape, but NO import of the callee's name. The guard must be
  // name-scoped — a genuine same-file callee has to survive it, or the fix trades a false positive for a
  // false negative across every intra-file call in the repo.
  w("src/plain.ts", `import { createBooking } from "./createBooking";

function localHelper(x: number) { return x + 1; }

export function outer(x: number) {
  const a = localHelper(x);
  return createBooking({ uid: String(a) });
}
`);
});

afterAll(() => { rmSync(REPO, { recursive: true, force: true }); });

describe("a bare call resolves to the module binding, not a same-named local", () => {
  test("an IMPORT shadows a same-named class method in the same file", async () => {
    const deps = await depsOf("src/service.ts", "handler");

    // the false RESOLVED_FULL edge: `handler` never calls `RegularBookingService.createBooking`
    expect(deps.some((d) => d.startsWith("createBooking@src/service.ts"))).toBe(false);
    // and the true one is present
    expect(deps.some((d) => d.startsWith("createBooking@src/createBooking.ts"))).toBe(true);
  });

  test("a genuine same-file callee still resolves (the guard is name-scoped)", async () => {
    const deps = await depsOf("src/plain.ts", "outer");

    // `localHelper` is NOT imported, so the same-file unit is the right answer and must survive
    expect(deps.some((d) => d.startsWith("localHelper@src/plain.ts"))).toBe(true);
    // ...while `createBooking`, which IS imported, still resolves out of the file
    expect(deps.some((d) => d.startsWith("createBooking@src/createBooking.ts"))).toBe(true);
  });
});

describe("a const-bound symbol works as an ANCHOR, not just as a target", () => {
  test("its OWN same-file callees resolve", async () => {
    // The other half of the same defect, and the reason the first fix was not enough. `add_dep` made a
    // const-bound export addressable as a dependency TARGET; the body passes still bailed when it was the
    // ANCHOR, because each re-looked-up a `named_units` unit by name and returned on the miss -- even though
    // the builder had already resolved the span through `wrapped_def_span`. The anchor pointed at the right
    // code and nothing read it.
    //
    // Measured on cal.com: `--query dependencies` on `createBooking.ts#createBooking` returned its imports but
    // NOT `saveBooking`, the same-file callee holding the prisma transaction (4 edges -> 8 after the fix), and
    // multi-hop traversal dead-ended on that node.
    const deps = await depsOf("src/createBooking.ts", "createBooking");
    expect(deps.some((d) => d.startsWith("prismaTransaction@src/createBooking.ts"))).toBe(true);
  });
});

describe("a const-bound export is addressable", () => {
  test("an import of `export const X = wrap(impl)` yields an edge, on the IMPL's line", async () => {
    const deps = await depsOf("src/service.ts", "handler");
    const dep = deps.find((d) => d.startsWith("createBooking@src/createBooking.ts"));

    // Before the fix this was `undefined`: no unit named `createBooking` and no `dep_line` to fall back on, so
    // the resolved import was dropped ENTIRELY and silently.
    expect(dep).toBeDefined();

    // Line 2 (0-based) = `const _createBooking = async (…) => {` — the implementation the wrapper wraps, NOT
    // line 8's `export const createBooking = withReporting(…)`. Landing on the wrapper would put the reader on
    // a one-line re-export instead of the body that does the work.
    expect(dep).toBe("createBooking@src/createBooking.ts:2");
  });
});
