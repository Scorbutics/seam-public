// PER-NODE COUPLING BUDGET — reproducibility. The per-node budget (SEAM_PER_NODE_BUDGET) re-baselines the
// coupling budget per node so each file's coupling is ORDER-INDEPENDENT; two grows of the same fixture under
// it must yield the identical node + edge set.
//
// WAS "parallel coupling is byte-identical to sequential". That contract is no longer testable here: the
// TypeScript worker pool is gone, the core parallelises coupling unconditionally with rayon
// (seam-grow/src/coupling.rs, `work.par_iter()`), and there is no switch. The flags this test used to flip —
// SEAM_PARALLEL_GROW, SEAM_GROW_WORKERS, SEAM_COUPLE_MIN — have no reader anywhere, so both halves ran the
// same code and that half of the assertion could not fail. SEAM_PER_NODE_BUDGET IS live, so what remains is
// real: the same grow, twice, under the per-node budget, agrees with itself.
// Hermetic (two throwaway tmp repos); guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";
import { available } from "../../src/codebase/atoms.js";

// A cross-stack fixture (the proven $http + JAX-RS route-coupling style): a JS frontend that hits backend ROUTES,
// each served by a Java @Path resource — so the seed + deep-couple fan couple MULTIPLE boundary files across the
// pool, with sibling JS callers of the same routes as complements. Produces real http-route coupling crossings.
const FIXTURE: Record<string, string> = {
  "web/memberBookings.js": `export function loadBookings( id ){ return $http.get( '/acme/rest/member/booking/v1/summarize/0/' + id ); }\nexport function pay(){ return $http.post('/acme/rest/member/booking/v1', {}); }\n`,
  "ejb/BookingsService.java": `package acme.rest;\nimport javax.ws.rs.*;\n@Path("member/booking")\npublic class BookingsService {\n  @GET @Path("v1/summarize/{p}/{id}") public Object paginate( String p, String id ){ return null; }\n  @POST @Path("v1") public Object createBooking( Object b ){ return null; }\n}\n`,
  "ejb/InvoiceService.java": `package acme.rest;\nimport javax.ws.rs.*;\n@Path("member/invoice")\npublic class InvoiceService {\n  @GET @Path("v1/list") public Object list(){ return null; }\n}\n`,
  "web/bookingPlugin.js": `const baseUrl = '/acme/rest/member/booking/v1';\nexport default { create( b ){ return fetch( baseUrl, { method: 'POST', body: b } ); } };\n`,
  "web/invoices.js": `export function listInvoices(){ return $http.get('/acme/rest/member/invoice/v1/list'); }\n`,
};

function writeFixture(repo: string): void {
  for (const [rel, text] of Object.entries(FIXTURE)) {
    const p = join(repo, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
}

function nodeKeys(data: any): string[] {
  return (data.nodes as any[]).map((n) => `${n.file ?? ""}#${n.symbol ?? ""}#${n.kind ?? ""}`).sort();
}
function edgeKeys(data: any): string[] {
  const by = new Map<string, string>((data.nodes as any[]).map((n) => [n.id, `${n.file ?? ""}#${n.symbol ?? ""}`]));
  return (data.edges as any[]).map((e) => `${by.get(e.from) ?? e.from}>${by.get(e.to) ?? e.to}:${e.kind ?? ""}:${e.provenance ?? ""}`).sort();
}

async function growWith(repo: string): Promise<any> {
  const prev = { b: process.env.SEAM_PER_NODE_BUDGET };
  process.env.SEAM_PER_NODE_BUDGET = "40";   // the re-baseline that makes coupling order-independent (both runs)
  try {
    const [data]: any = await grow_to_terminals(repo, "web/memberBookings.js", "loadBookings",
      { maxSteps: 20, maxNodes: 100, dataCoupling: true, ctx: new EngineCtx() } as any);
    return data;
  } finally {
    prev.b === undefined ? delete process.env.SEAM_PER_NODE_BUDGET : (process.env.SEAM_PER_NODE_BUDGET = prev.b);
  }
}

describe("the per-node coupling budget makes a grow reproducible", () => {
  const repoSeq = join(tmpdir(), "seam-pcouple-seq-" + process.pid);
  const repoPar = join(tmpdir(), "seam-pcouple-par-" + process.pid);
  beforeAll(() => { writeFixture(repoSeq); writeFixture(repoPar); });
  afterAll(() => { rmSync(repoSeq, { recursive: true, force: true }); rmSync(repoPar, { recursive: true, force: true }); });

  test("same node + edge set across two grows under the per-node budget", async () => {
    if (!available()) return;                     // needs tree-sitter (coupling resolution)
    const seq = await growWith(repoSeq);
    const par = await growWith(repoPar);
    // sanity: the deep-couple actually produced cross-boundary coupling nodes (else the test is vacuous)
    expect((seq.nodes as any[]).some((n) => n.coupling)).toBe(true);
    expect(nodeKeys(par)).toEqual(nodeKeys(seq));
    expect(edgeKeys(par)).toEqual(edgeKeys(seq));
  }, 60_000);
});
