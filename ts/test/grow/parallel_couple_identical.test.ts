// PARALLEL COUPLING (the 2.4× win) — the deep-couple fan (`_fanCouple`) resolves each boundary file's coupling
// OFF-THREAD across a worker pool, while the merge stays on the main thread consuming deltas in file order. The
// contract: with the PER-NODE budget (SEAM_PER_NODE_BUDGET — which makes each file's coupling order-independent)
// the parallel grow is BYTE-IDENTICAL to the per-node SEQUENTIAL grow. This locks that: the same coupling-heavy
// fixture grown with SEAM_PARALLEL_GROW on vs off (both per-node) must yield the identical node + edge set.
// Hermetic (two throwaway tmp repos); guards on tree-sitter + Worker.
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

async function growWith(repo: string, parallel: boolean): Promise<any> {
  const prev = { p: process.env.SEAM_PARALLEL_GROW, b: process.env.SEAM_PER_NODE_BUDGET, w: process.env.SEAM_GROW_WORKERS, m: process.env.SEAM_COUPLE_MIN };
  process.env.SEAM_PER_NODE_BUDGET = "40";   // the re-baseline that makes coupling order-independent (both runs)
  // parallel=false uses the explicit kill-switch (SEAM_PARALLEL_GROW=0), NOT unset — the pool is DEFAULT-ON now.
  process.env.SEAM_PARALLEL_GROW = parallel ? "1" : "0";
  if (parallel) { process.env.SEAM_GROW_WORKERS = "2"; process.env.SEAM_COUPLE_MIN = "1"; }   // force the pool to engage on the small fixture
  try {
    const [data]: any = await grow_to_terminals(repo, "web/memberBookings.js", "loadBookings",
      { maxSteps: 20, maxNodes: 100, dataCoupling: true, ctx: new EngineCtx() } as any);
    return data;
  } finally {
    prev.p === undefined ? delete process.env.SEAM_PARALLEL_GROW : (process.env.SEAM_PARALLEL_GROW = prev.p);
    prev.b === undefined ? delete process.env.SEAM_PER_NODE_BUDGET : (process.env.SEAM_PER_NODE_BUDGET = prev.b);
    prev.w === undefined ? delete process.env.SEAM_GROW_WORKERS : (process.env.SEAM_GROW_WORKERS = prev.w);
    prev.m === undefined ? delete process.env.SEAM_COUPLE_MIN : (process.env.SEAM_COUPLE_MIN = prev.m);
  }
}

describe("parallel coupling is byte-identical to sequential (per-node budget)", () => {
  const repoSeq = join(tmpdir(), "seam-pcouple-seq-" + process.pid);
  const repoPar = join(tmpdir(), "seam-pcouple-par-" + process.pid);
  beforeAll(() => { writeFixture(repoSeq); writeFixture(repoPar); });
  afterAll(() => { rmSync(repoSeq, { recursive: true, force: true }); rmSync(repoPar, { recursive: true, force: true }); });

  test("same node + edge set with SEAM_PARALLEL_GROW on vs off", async () => {
    if (!available()) return;                     // needs tree-sitter (coupling resolution)
    if (typeof Worker === "undefined") return;    // no worker threads → parallel degrades to sequential anyway
    const seq = await growWith(repoSeq, false);
    const par = await growWith(repoPar, true);
    // sanity: the deep-couple actually produced cross-boundary coupling nodes (else the test is vacuous)
    expect((seq.nodes as any[]).some((n) => n.coupling)).toBe(true);
    expect(nodeKeys(par)).toEqual(nodeKeys(seq));
    expect(edgeKeys(par)).toEqual(edgeKeys(seq));
  }, 60_000);
});
