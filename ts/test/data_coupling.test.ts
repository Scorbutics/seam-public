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

  test("--no-data-coupling disables the boundary entirely", async () => {
    const g = await build_dependency_graph(repo, "src/backend/persist.ts", "persistPayment", { dataCoupling: false });
    expect(g.nodes.some((n: any) => n.kind === "table")).toBe(false);
  });
});
