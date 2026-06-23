// Constant-resolved param coupling (the Dubbo / RPC case the LLM flywheel misses): a framework keys its
// couplings by a NAMED CONSTANT, not a literal — `url.getParameter(TIMEOUT_KEY)` (consume) ⇄
// `url.addParameter(TIMEOUT_KEY, …)` (produce), where `String TIMEOUT_KEY = "timeout"` lives in a constants
// interface. The two sides SPELL the key the same (TIMEOUT_KEY) but the LLM flywheel re-spells it ("timeout"
// vs the constant name) so they never co-occur. The deterministic floor builds a repo-wide CONST→VALUE map
// and resolves every getParameter/addParameter arg through it, so both sides land on ONE value ("timeout")
// and ground. Hermetic — throwaway tmp repo.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveParamKeys } from "../../src/codebase/coupling/const_keys.js";
import { build_module_graph } from "../../src/codebase/scan/module_graph.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(tmpdir(), "seam-constkeys-test-" + process.pid);
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  // The constants interface — fields are implicitly static final String. TOKEN_KEY is declared but NEVER
  // used, to prove a bare declaration does NOT create a coupling key.
  write("Constants.java",
    "public interface Constants {\n" +
    '  String TIMEOUT_KEY = "timeout";\n' +
    '  String TOKEN_KEY = "token";\n' +
    "}\n");
  // PRODUCER: writes the param via the constant.
  write("Provider.java",
    "class Provider {\n" +
    "  void configure(URL url) {\n" +
    "    url.addParameter(TIMEOUT_KEY, 5000);\n" +
    '    url.addParameter("weight", 100);\n' +   // a LITERAL key (the easy case must keep working)
    "  }\n" +
    "}\n");
  // CONSUMER: reads the same param via a QUALIFIED constant (Class.CONSTANT) — and one unresolvable var.
  write("Filter.java",
    "class Filter {\n" +
    "  int read(URL url, String dynamic) {\n" +
    "    int t = url.getParameter(Constants.TIMEOUT_KEY, 1000);\n" +
    '    int w = url.getParameter("weight", 1);\n' +
    "    return url.getParameter(dynamic);\n" +   // unresolvable variable → no key
    "  }\n" +
    "}\n");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("resolveParamKeys — constant resolution + grounding", () => {
  test("a constant key grounds cross-file (producer ⇄ consumer on the resolved value)", () => {
    const idx = resolveParamKeys(REPO);
    const timeout = idx.get("key timeout");
    expect(timeout).toBeDefined();
    expect(timeout!.producers.some((a) => a.file === "Provider.java")).toBe(true);   // addParameter(TIMEOUT_KEY)
    expect(timeout!.consumers.some((a) => a.file === "Filter.java")).toBe(true);     // getParameter(Constants.TIMEOUT_KEY)
  });
  test("a literal key still grounds (resolution doesn't break the easy case)", () => {
    const w = resolveParamKeys(REPO).get("key weight");
    expect(w?.producers.some((a) => a.file === "Provider.java")).toBe(true);
    expect(w?.consumers.some((a) => a.file === "Filter.java")).toBe(true);
  });
  test("a declared-but-unused constant creates NO key, and an unresolvable variable arg is skipped", () => {
    const idx = resolveParamKeys(REPO);
    expect(idx.has("key token")).toBe(false);     // TOKEN_KEY declared, never used in get/addParameter
    // the only keys are the two genuinely used ones — no junk from `getParameter(dynamic)`
    expect([...idx.keys()].sort()).toEqual(["key timeout", "key weight"]);
  });
  test("SEAM_NO_ADAPTERS gates the floor (param_key_index returns empty)", async () => {
    const { param_key_index } = await import("../../src/codebase/coupling/index.js");   // moved: built in the fused floor pass
    const { EngineCtx } = await import("../../src/codebase/engine_ctx.js");
    const prev = process.env.SEAM_NO_ADAPTERS;
    process.env.SEAM_NO_ADAPTERS = "1";
    try { expect(param_key_index(REPO, new Set(["node_modules", ".git"]), new EngineCtx()).size).toBe(0); }
    finally { if (prev === undefined) delete process.env.SEAM_NO_ADAPTERS; else process.env.SEAM_NO_ADAPTERS = prev; }
  });

  test("fused builder: param_key_index + shared_key_index share ONE pass and agree with the standalone walk", async () => {
    const { param_key_index, shared_key_index } = await import("../../src/codebase/coupling/index.js");
    const { EngineCtx } = await import("../../src/codebase/engine_ctx.js");
    const ctx = new EngineCtx();
    const fused = param_key_index(REPO, new Set(["node_modules", ".git"]), ctx);
    shared_key_index(REPO, new Set(["node_modules", ".git"]), ctx);   // same ctx → must reuse the one build
    // the fused param index matches the standalone resolveParamKeys (behaviour-identical), and the shared
    // index was populated in the same pass (cached on the ctx)
    expect([...fused.keys()].sort()).toEqual([...resolveParamKeys(REPO).keys()].sort());
    expect(ctx.sharedKey.has(REPO)).toBe(true);
    expect(ctx.paramKeys.has(REPO)).toBe(true);
  });
});

// The end-to-end win: the consumer, anchored alone, reaches the producer through the const-resolved key
// boundary — across files, with NO call edge between them, FLOOR-only (no LLM).
describe("cross-file: a getParameter(CONST) consumer reaches the addParameter(CONST) producer", () => {
  test("Filter.getParameter(TIMEOUT_KEY) couples to Provider.addParameter(TIMEOUT_KEY)", async () => {
    if (!available()) return;   // tree-sitter required to parse the anchor module
    const g = await build_module_graph(REPO, "Filter.java", { dataCoupling: true });
    const files = (g.nodes ?? []).map((n: any) => n.file);
    expect(files.some((f: string) => f.endsWith("Provider.java"))).toBe(true);
    // a resolved-key boundary node was materialised on the shared value
    expect((g.nodes ?? []).some((n: any) => n.coupling && (n.symbol === "timeout" || n.symbol === "weight"))).toBe(true);
  });
});
