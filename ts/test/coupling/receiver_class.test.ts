// RECEIVER CLASSIFICATION + the LLM type-confirmation rung. The 2-part `repository` shape has no 3-part
// guard, so `axios.create()`/`axios.delete()` are structurally identical to a repo and the cheap layers
// confidently mis-type them. The LLM rung is what separates axios-the-http-client from
// userRepository-the-data-layer. This test stubs the LLM and asserts only the database-confirmed receiver
// becomes a `repository` matcher.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { classifyAndPersistRepositories } from "../../src/codebase/coupling/receiver_class.js";
import { _resetKeyStoreMem } from "../../src/codebase/coupling/key_store.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";

let REPO: string, SHARED: string;

// Stub: for the classify-receivers pass, confirm userRepository=database, axios=http (the dev's judgment).
class ClsBus extends HostBus {
  asked = 0;
  serve(tag: string, _prompt: string): string {
    if (tag !== "classify-receivers") return "[]";
    this.asked++;
    return JSON.stringify([{ id: "userRepository", type: "database" }, { id: "axios", type: "http" }]);
  }
}

beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "rc-repo-")); SHARED = mkdtempSync(join(tmpdir(), "rc-shared-"));
  process.env.SEAM_ADAPTERS_DIR = SHARED; _resetKeyStoreMem(); set_host_bus(null);
  // ≥4 files (MIN_FILES) each using BOTH receivers with a read AND a write verb → both are candidates
  for (let i = 0; i < 5; i++) {
    mkdirSync(join(REPO, "src"), { recursive: true });
    writeFileSync(join(REPO, "src", `f${i}.ts`),
      `export const a${i} = async () => { await userRepository.create({}); const u = await userRepository.findMany(); await axios.get('/x'); const c = axios.create(); return u; };\n`);
  }
});
afterEach(() => {
  rmSync(REPO, { recursive: true, force: true }); rmSync(SHARED, { recursive: true, force: true });
  delete process.env.SEAM_ADAPTERS_DIR; _resetKeyStoreMem(); set_host_bus(null);
});

describe("receiver classification — LLM confirms type, drops the http look-alike", () => {
  test("userRepository → repository (db-table); axios → http-route channel, NOT a database table", async () => {
    const bus = new ClsBus(); set_host_bus(bus);
    const ms = await classifyAndPersistRepositories(REPO, { llm: true }, new EngineCtx());
    expect(bus.asked).toBe(1);                                   // the LLM was consulted
    const kindsOf = (tok: string) => [...new Set(ms.filter((m: any) => m.token === tok).map((m: any) => `${m.via}/${m.kind}`))];
    // database-confirmed → repository (the receiver is the table), split read/write
    expect(kindsOf("userRepository")).toEqual(["repository/db-table"]);
    expect(ms.filter((m: any) => m.token === "userRepository").map((m: any) => m.role).sort()).toEqual(["consumes", "produces"]);
    // http-confirmed → an http-route CHANNEL (the route is the key), NOT mis-typed as a db-table (P1's win:
    // no 3-part guard, but the LLM separates the http client from the data layer)
    expect(kindsOf("axios")).toEqual(["channel/http-route"]);
  });

  test("no LLM backend → no classification (degrades to member_access only)", async () => {
    set_host_bus(null);
    const ms = await classifyAndPersistRepositories(REPO, { llm: false }, new EngineCtx());
    expect(ms).toEqual([]);
  });
});
