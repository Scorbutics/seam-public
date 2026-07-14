// METHOD-PRECISE fan attribution — the whole-file coupling fan used to wire EVERY write in a reached file to the
// ONE reached node, so a class's SIBLING methods bled onto it (keycloak `grantRole` credited with the
// UserAttribute/RequiredAction writes it never touches; a whole-CLASS node absorbing the entire file → a garbage
// entity crown). The fix re-attributes each crossing to the METHOD enclosing its write line, within the reached
// method's same-file call CLOSURE: a DELEGATE the reached method calls (`grantRoleImpl`) gets the write (minted +
// wired), a SIBLING it never calls is DROPPED. Hermetic tmp repo, tree-sitter-guarded.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";

describe("method-precise fan attribution: a delegate's write, not a sibling's, reaches the flow", () => {
  let REPO: string;
  const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "method-precise-"));
    // handler → grantRole → grantRoleImpl (writes `role_mappings`). `setAttribute` (writes `attributes`) is a SIBLING
    // grantRole NEVER calls — the old whole-file fan bled it onto grantRole. Unqualified same-file calls so the
    // closure (via `_call_lines`) resolves them (mirrors Java's implicit-`this` `grantRoleImpl(role)`).
    w("src/svc.ts", [
      "export function grantRole(db: any) {",
      "  grantRoleImpl(db);",
      "}",
      "function grantRoleImpl(db: any) {",
      "  return db.from('role_mappings').insert({ role: 1 });",
      "}",
      "function setAttribute(db: any) {",
      "  return db.from('attributes').insert({ a: 1 });",
      "}",
    ].join("\n") + "\n");
    w("src/entry.ts", [
      "import { grantRole } from './svc';",
      "export function handler(db: any) {",
      "  return grantRole(db);",
      "}",
    ].join("\n") + "\n");
    // READER complements — a data-coupling crossing needs the OTHER side of the table (a reader), else no boundary
    // materialises. Each write table has one, so `role_mappings`/`attributes` are real cross-file boundaries.
    w("src/reports.ts", [
      "export function listRoleMappings(db: any) { return db.from('role_mappings').select('*'); }",
      "export function listAttributes(db: any) { return db.from('attributes').select('*'); }",
    ].join("\n") + "\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  // the db-tables WRITTEN by a node in svc.ts (the reached file) — the bleed is a write edge from a svc.ts node to a
  // table its method never touches. NB: `attributes` still appears as a READ boundary (reports.ts reads it), so we
  // assert on the WRITE side from svc.ts, not mere table presence.
  const svcWrites = (data: any): Set<string> => {
    const svc = new Set(data.nodes.filter((n: any) => String(n.file).endsWith("svc.ts")).map((n: any) => n.id));
    const label = new Map(data.nodes.map((n: any) => [n.id, String(n.symbol)]));
    const out = new Set<string>();
    for (const e of data.edges) if (e.kind === "db-write" && svc.has(e.from)) out.add(label.get(e.to) ?? "");
    return out;
  };

  test("the delegate's write is attributed to it; the sibling's write does NOT bleed onto the reached method", async () => {
    if (!available()) return;
    const [data]: any = await grow_to_terminals(REPO, "src/entry.ts", "handler", { maxSteps: 8, maxNodes: 40, dataCoupling: true } as any);
    const writes = svcWrites(data);
    expect([...writes]).toContain("role_mappings");        // grantRole → grantRoleImpl (in the closure) → written
    expect([...writes]).not.toContain("attributes");        // setAttribute (never called by grantRole) → dropped, no bleed
  });

  test("SEAM_METHOD_PRECISE=0 restores the whole-file bleed (the sibling write reappears on the reached node)", async () => {
    if (!available()) return;
    const prev = process.env.SEAM_METHOD_PRECISE; process.env.SEAM_METHOD_PRECISE = "0";
    try {
      const [data]: any = await grow_to_terminals(REPO, "src/entry.ts", "handler", { maxSteps: 8, maxNodes: 40, dataCoupling: true } as any);
      const writes = svcWrites(data);
      expect([...writes]).toContain("attributes");          // opt-out = old whole-file fan bleeds the sibling write in
    } finally { if (prev === undefined) delete process.env.SEAM_METHOD_PRECISE; else process.env.SEAM_METHOD_PRECISE = prev; }
  });
});
