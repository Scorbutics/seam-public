// SHARED-KEY coupling (the unified tier-2.5/3 rung): data-flow couplings across a DB boundary that no
// import/call edge can see. A backend WRITE to a table couples to where it's READ (and vice versa),
// surfaced as a `table` boundary node + crossing fan. Two front-ends ground through the SAME index:
// the deterministic Supabase regex floor, and the LLM (discover_keys) for cross-framework keys.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { build_dependency_graph } from "../src/codebase/import_scan.js";
import { scan_file_keys } from "../src/codebase/coupling/index.js";
import { from_resolved_graph } from "../src/core/graph_ir.js";
import { _is_crossing } from "../src/codebase/codebase.js";
import { HostBus, set_host_bus } from "../src/core/llm.js";

const __dir = import.meta.dir;
const repo = join(__dir, "fixtures", "supa-repo");

describe("shared-key (data-flow) coupling", () => {
  test("scan_file_keys classifies db-table read vs write across a multiline builder chain", () => {
    expect(scan_file_keys("a.ts", `client\n  .from('payments')\n  .insert({a:1});`)).toEqual([{ kind: "db-table", value: "payments", line: 1, produces: true }]);
    expect(scan_file_keys("a.ts", `x.from('payments').select('*').eq('id', id)`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: false }]);
    expect(scan_file_keys("a.ts", "const x = 1;")).toEqual([]);
  });

  test("a writer surfaces a table boundary node + the readers as db-read crossings (det floor)", async () => {
    const g = await build_dependency_graph(repo, "src/backend/persist.ts", "persistPayment");
    const tbl = g.nodes.find((n: any) => n.kind === "table" && n.symbol === "payments");
    expect(tbl).toBeDefined();
    expect(tbl.file).toBe("src/backend/persist.ts");
    expect(g.edges).toContainEqual({ from: "n1", to: tbl.id, kind: "db-write", provenance: "RESOLVED_PARTIAL", line: tbl.range[0] });
    const readerSyms = g.edges.filter((e: any) => e.from === tbl.id && e.kind === "db-read")
      .map((e: any) => g.nodes.find((n: any) => n.id === e.to).symbol).sort();
    expect(readerSyms).toEqual(["paymentHistory", "showInvoice"]);
  });

  test("symmetric: a reader surfaces the WRITER as a db-write crossing", async () => {
    const g = await build_dependency_graph(repo, "src/ui/invoice.ts", "showInvoice");
    const tbl = g.nodes.find((n: any) => n.kind === "table" && n.symbol === "payments");
    expect(tbl).toBeDefined();
    // the reader's own edge to the table is a db-read; the surfaced producer's is a db-write
    expect(g.edges).toContainEqual({ from: "n1", to: tbl.id, kind: "db-read", provenance: "RESOLVED_PARTIAL", line: tbl.range[0] });
    const producers = g.edges.filter((e: any) => e.from === tbl.id && e.kind === "db-write")
      .map((e: any) => g.nodes.find((n: any) => n.id === e.to).symbol);
    expect(producers).toContain("persistPayment");
  });

  test("the shared-key edges are crossings (the orchestrator's frontier)", async () => {
    const g = from_resolved_graph(await build_dependency_graph(repo, "src/backend/persist.ts", "persistPayment"));
    const crossings = g.resolved_edges().filter(_is_crossing).map((e) => e.kind).sort();
    expect(crossings).toEqual(["db-read", "db-read", "db-write"]);
  });

  test("LLM-proposed key (Prisma write, invisible to the regex floor) grounds through the SAME index", async () => {
    // The regex floor sees NOTHING in this anchor (Prisma `.create`, not `.from().insert`). The LLM
    // proposes the db-table key; it grounds via the index (which knows the Supabase readers).
    set_host_bus(new HostBus({ "discover": "[]", "discover-keys": '[{"id":"k1","kind":"db-table","value":"payments","role":"produces"}]' }));
    let g: any;
    try { g = await build_dependency_graph(repo, "src/backend/prisma_persist.ts", "prismaPersist", { dataCouplingLlm: true }); }
    finally { set_host_bus(null); }
    const tbl = g.nodes.find((n: any) => n.kind === "table" && n.symbol === "payments");
    expect(tbl).toBeDefined(); // surfaced PURELY from the LLM proposal + the shared index
    const readerSyms = g.edges.filter((e: any) => e.from === tbl.id && e.kind === "db-read")
      .map((e: any) => g.nodes.find((n: any) => n.id === e.to).symbol).sort();
    expect(readerSyms).toEqual(["paymentHistory", "showInvoice"]);
  });

  // The cross-language raw-SQL adapter: SQL DML text is uniform across host languages, so one scan
  // covers JDBC/libpq/sqlite/raw queries in Java/C/C++/Ruby/TS — emitting the same `db-table` key.
  test("raw-SQL adapter classifies DML cross-language (Java/C/Ruby filenames)", () => {
    expect(scan_file_keys("Dao.java", `String q = "INSERT INTO payments (id) VALUES (?)";`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: true }]);
    expect(scan_file_keys("db.c", `sqlite3_exec(db, "DELETE FROM payments WHERE id=1", 0,0,0);`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: true }]);
    expect(scan_file_keys("m.rb", `Payment.find_by_sql("SELECT * FROM payments WHERE id = ?")`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: false }]);
    expect(scan_file_keys("u.java", `em.createQuery("UPDATE payments SET amount = :a")`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: true }]);
    // schema-qualified + quoted identifiers normalize to the bare table name
    expect(scan_file_keys("x.c", `"INSERT INTO public.payments(id) VALUES(1)"`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: true }]);
    expect(scan_file_keys("x.c", "\"SELECT id FROM `payments`\"")).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: false }]);
  });

  test("raw-SQL adapter does NOT false-match a JS `import … from \"mod\"` (needs SELECT)", () => {
    expect(scan_file_keys("a.ts", `export { x } from "./helpers";\nimport y from "lib";`)).toEqual([]);
  });

  test("cross-stack: a Supabase read and a raw-SQL write on the SAME table share one db-table key", () => {
    const hits = scan_file_keys("mixed.ts", `client.from('payments').select('*');\nconst q = "INSERT INTO payments (id) VALUES (1)";`);
    expect(hits).toContainEqual({ kind: "db-table", value: "payments", line: 0, produces: false }); // Supabase builder → read
    expect(hits).toContainEqual({ kind: "db-table", value: "payments", line: 1, produces: true });  // raw SQL → write
  });

  test("a raw-SQL writer couples to the Supabase readers of the same table (cross-stack, end-to-end)", async () => {
    const g = await build_dependency_graph(repo, "src/backend/sql_report.ts", "archivePayment");
    const tbl = g.nodes.find((n: any) => n.kind === "table" && n.symbol === "payments");
    expect(tbl).toBeDefined(); // detected purely from the raw INSERT — no Supabase builder in this file
    const readerSyms = g.edges.filter((e: any) => e.from === tbl.id && e.kind === "db-read")
      .map((e: any) => g.nodes.find((n: any) => n.id === e.to).symbol).sort();
    expect(readerSyms).toEqual(["paymentHistory", "showInvoice"]);
  });

  // Tier-1 convention adapters: table identity is a model/codegen constant, not a string literal.
  test("ActiveRecord (Ruby): Model.<method> → tableized model, AR-distinctive methods only", () => {
    expect(scan_file_keys("m.rb", `Payment.where(active: true)`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: false }]);
    expect(scan_file_keys("m.rb", `Payment.create!(amount: 1)`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: true }]);
    expect(scan_file_keys("m.rb", `UserProfile.find_each { |u| }`)).toEqual([{ kind: "db-table", value: "user_profiles", line: 0, produces: false }]);
    expect(scan_file_keys("m.rb", `Category.where(id: 1)`)).toEqual([{ kind: "db-table", value: "categories", line: 0, produces: false }]); // y→ies
    // ambiguous `Const.method` on non-models must NOT match (find/delete/parse excluded)
    expect(scan_file_keys("m.rb", `File.delete(path)\nJSON.parse(s)\nUser.find(1)`)).toEqual([]);
    // gated to .rb — the same text in a .ts file is not ActiveRecord
    expect(scan_file_keys("a.ts", `Payment.where(active: true)`)).toEqual([]);
  });

  test("jOOQ (Java): insertInto/selectFrom/update(CONST) → lowercased table constant", () => {
    expect(scan_file_keys("Dao.java", `dsl.insertInto(PAYMENTS).values(1)`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: true }]);
    expect(scan_file_keys("Dao.java", `dsl.selectFrom(Tables.PAYMENTS).fetch()`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: false }]);
    expect(scan_file_keys("Dao.java", `dsl.update(PAYMENTS).set(F, v)`)).toEqual([{ kind: "db-table", value: "payments", line: 0, produces: true }]);
    // ambiguous `.update(lowercaseArg)` (e.g. MessageDigest) must NOT match
    expect(scan_file_keys("C.java", `messageDigest.update(bytes)`)).toEqual([]);
  });

  test("cross-LANGUAGE coupling: a Ruby AR reader couples to the SQL/Supabase writers of the table", async () => {
    const xrepo = join(__dir, "fixtures", "xlang-repo");
    const g = await build_dependency_graph(xrepo, "src/writer.ts", "archivePayment"); // raw-SQL writer of `payments`
    const tbl = g.nodes.find((n: any) => n.kind === "table" && n.symbol === "payments");
    const readerFiles = g.edges.filter((e: any) => e.from === tbl.id && e.kind === "db-read")
      .map((e: any) => g.nodes.find((n: any) => n.id === e.to).file).sort();
    expect(readerFiles).toContain("app/reports.rb");    // Ruby ActiveRecord reader, found cross-language
    expect(readerFiles).toContain("src/invoice.ts");    // TS Supabase reader — coupled to a SQL writer
  });

  test("--no-data-coupling disables the boundary entirely", async () => {
    const g = await build_dependency_graph(repo, "src/backend/persist.ts", "persistPayment", { dataCoupling: false });
    expect(g.nodes.some((n: any) => n.kind === "table")).toBe(false);
  });
});
