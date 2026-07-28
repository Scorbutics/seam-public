// CARRIER http-route MEDIUM — the project-level learning lever. The carrier framework already learns
// "callee X is a channel of medium M" once (LLM), caches it, and applies it deterministically on warm
// passes (and it's promotable via the Adapters view). This adds an `http-route` medium so a learned
// signature for a project's OWN HTTP client (a custom `Vue.http`/`apiClient` wrapper) grounds the frontend
// call under the SAME `http-route <path>` key the deterministic adapters use — meeting the backend handler.
// The GROUNDING pass those assertions covered (expandAndIndexHits: medium → kind, URL normalisation, and
// that http-route URLs and data-file paths NEVER cross-ground) moved with the engine into the core — it is
// pinned by `grounding_tests` in crates/seam-couple/src/carrier/engine.rs. What stays here is the STORE
// gate, which is still TypeScript.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasLearnedCarrier, _resetCarrierCacheMem } from "../../src/codebase/coupling/carrier/cache.js";

// AUTO-REUSE GATE — a learned carrier signature must apply on the NEXT (warm) pass WITHOUT --llm and WITHOUT
// promotion. `hasLearnedCarrier` is the gate that opens the carrier engine for a non-Ruby anchor on a warm
// floor pass; an empty repo keeps it shut (cold non-Ruby floor pays nothing → existing behaviour unchanged).
describe("hasLearnedCarrier — the warm auto-reuse gate (reuse before promote)", () => {
  let REPO: string;
  afterEach(() => { if (REPO) rmSync(REPO, { recursive: true, force: true }); _resetCarrierCacheMem(); });

  test("a repo with no learned adapter → gate shut (false)", () => {
    REPO = mkdtempSync(join(tmpdir(), "carrier-gate-"));
    _resetCarrierCacheMem();
    expect(hasLearnedCarrier(REPO)).toBe(false);
  });
  test("a repo-local learned signature → gate open (true), no promotion needed", () => {
    REPO = mkdtempSync(join(tmpdir(), "carrier-gate-"));
    mkdirSync(join(REPO, ".seam"), { recursive: true });
    writeFileSync(join(REPO, ".seam", "carrier-signatures.json"), JSON.stringify({
      schema: 1, signatures: { "VueHttp#get h1": { direction: "read", medium: "http-route", keyArg: 0, name: "vue-http", description: "project HTTP client" } },
    }));
    _resetCarrierCacheMem();
    expect(hasLearnedCarrier(REPO)).toBe(true);
  });
  test("only a null (known-NON-carrier) entry → still shut (no real adapter to reuse)", () => {
    REPO = mkdtempSync(join(tmpdir(), "carrier-gate-"));
    mkdirSync(join(REPO, ".seam"), { recursive: true });
    writeFileSync(join(REPO, ".seam", "carrier-signatures.json"), JSON.stringify({ schema: 1, signatures: { "Foo#noop h2": null } }));
    _resetCarrierCacheMem();
    expect(hasLearnedCarrier(REPO)).toBe(false);
  });
});
