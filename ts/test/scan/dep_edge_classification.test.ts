// REGRESSION (Direction B): the DOWN dependency graph distinguishes DELEGATION (a type the anchor actually
// CALLS — the spine, `import`) from a pure PAYLOAD type-ref (a DTO returned/passed but never invoked,
// `type-ref`). The walk demotes type-ref payloads so the budget follows the call spine (service → repo →
// entityManager), not the data-model type tree. Crucially the @Inject FIELD bean (`BookingRepo repo;` — type
// on the parent declaration, the central delegation target) is resolved as called. Hermetic; guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_dependency_graph } from "../../src/codebase/scan/down/dependency_graph.js";
import { available } from "../../src/codebase/atoms.js";

const repo = join(tmpdir(), "seam-dep-edge-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("src/BookingsService.java",
    `package a;\npublic class BookingsService {\n  BookingRepo repo;\n  public BookingData createBooking(CreateRequest req, User user){\n    BookingData data = new BookingData();\n    repo.save(data);\n    return data;\n  }\n}\n`);
  w("src/BookingRepo.java", `package a;\npublic class BookingRepo { public void save(BookingData d){} }\n`);
  w("src/BookingData.java", `package a;\npublic class BookingData { public int id; }\n`);
  w("src/CreateRequest.java", `package a;\npublic class CreateRequest { public int memberId; }\n`);
  w("src/User.java", `package a;\npublic class User { public String name; }\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("dependency edge classification — delegation (import) vs payload (type-ref)", () => {
  test("the invoked field bean is `import`; the DTO return/param types are `type-ref`", async () => {
    if (!available()) return;
    const g: any = await build_dependency_graph(repo, "src/BookingsService.java", "createBooking", { dataCoupling: false });
    const kindOf = (sym: string) => { const n = g.nodes.find((x: any) => x.symbol === sym); const e = g.edges.find((x: any) => x.to === n?.id); return e?.kind; };
    expect(kindOf("BookingRepo")).toBe("import");        // repo.save(...) — DELEGATION (field type resolved off the parent decl)
    expect(kindOf("BookingData")).toBe("type-ref");      // returned/constructed, never invoked — payload
    expect(kindOf("CreateRequest")).toBe("type-ref");    // a param type — payload
    expect(kindOf("User")).toBe("type-ref");             // a param type — payload
  });
});
