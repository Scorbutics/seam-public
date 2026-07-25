// REGRESSION — a bare same-name call in the anchor's OWN file is NOT the anchor when that name is bound by
// an IMPORT in that file. The intra-file pass matched the bare NAME `createBooking(...)` to the METHOD
// `RegularBookingService.createBooking` even though line 122 of the same file reads
// `import { createBooking } from "../handleNewBooking/createBooking"` — a different symbol that merely shares
// the name — and reported it as RESOLVED_FULL, Seam's "verified edge" tier (cal.com,
// packages/features/bookings/lib/service/RegularBookingService.ts:1939).
//
// An import declaration IS the file's module-scope binding for that name, so a bare use there is PROVABLY the
// import. A receiver-qualified `this.m()` / `obj.m()` is a member access and can still be the anchor, so the
// drop is bare-only — a false positive is never traded for a false negative. Both directions are asserted:
// (a) the import-shadowed bare call is gone, (b) genuine intra-file callers (a bare call to a symbol the file
// does NOT import, and a `this.method()` call) still reach the anchor. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_resolved_graph } from "../../src/codebase/scan/up/consumers_graph.js";
import { available } from "../../src/codebase/atoms.js";
import { resetRepoImports } from "../../src/core/resolve/consumers.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "intrafile-collision-"));
  // The IMPORTED free function — a genuinely different symbol that happens to share the method's name.
  w("src/lib/createBooking.ts", `export async function createBooking(input: { uid: string }) {\n  return { id: input.uid };\n}\n`);
  // The anchor file: imports the free function AND declares a METHOD of the same name on its service class.
  w("src/service/BookingService.ts", [
    `import { createBooking } from "../lib/createBooking";`,
    ``,
    `export async function handler(uid: string) {`,
    `  // BARE call — the module-scope binding here is the IMPORT, never the method below.`,
    `  return await createBooking({ uid });`,
    `}`,
    ``,
    `export function localHelper(uid: string) {`,
    `  // BARE call to a name the file does NOT import — a genuine intra-file caller.`,
    `  return buildUid(uid);`,
    `}`,
    ``,
    `export function buildUid(uid: string) {`,
    `  return uid.trim();`,
    `}`,
    ``,
    `export class BookingService {`,
    `  async createBooking(input: { uid: string }) {`,
    `    return handler(input.uid);`,
    `  }`,
    `  async createTwice(uid: string) {`,
    `    // RECEIVER-QUALIFIED — a real call on the anchor's own class, must survive.`,
    `    await this.createBooking({ uid });`,
    `    return this.createBooking({ uid });`,
    `  }`,
    `}`,
    ``,
  ].join("\n"));
  resetRepoImports();
});
afterAll(() => { rmSync(REPO, { recursive: true, force: true }); resetRepoImports(); });

const ANCHOR = "src/service/BookingService.ts";

// The consumers reported for `symbol` that live in the anchor file itself, as [caller, edge kind].
const intraFileCallers = async (symbol: string): Promise<Array<[string, string]>> => {
  const g = await build_resolved_graph(REPO, ANCHOR, symbol, { depth: 1, dataCoupling: false });
  const byId = new Map(g.nodes.map((n: any) => [n.id, n]));
  return g.edges
    .filter((e: any) => e.to === "n1" && byId.get(e.from)?.file === ANCHOR)
    .map((e: any) => [byId.get(e.from)!.symbol as string, e.kind as string])
    .sort();
};

describe("intra-file name collision with an import binding", () => {
  test("a bare same-name call whose name is import-bound in the file is NOT attributed to the method", async () => {
    if (!available()) return;
    const callers = (await intraFileCallers("createBooking")).map(([s]) => s);
    // `handler` calls the IMPORTED createBooking — it must not appear as a caller of the METHOD.
    expect(callers).not.toContain("handler");
  });

  test("a receiver-qualified call on the anchor's own class is still attributed", async () => {
    if (!available()) return;
    const callers = (await intraFileCallers("createBooking")).map(([s]) => s);
    expect(callers).toContain("createTwice");
  });

  test("a genuine intra-file bare call (name not import-bound) is still a RESOLVED_FULL call edge", async () => {
    if (!available()) return;
    expect(await intraFileCallers("buildUid")).toContainEqual(["localHelper", "call"]);
  });
});
