// MODULE-SCOPED per-file LLM synthesis: on a monorepo the flywheel must LLM only the anchor's module, not
// the whole repo (other modules warm lazily as the grow re-anchors into them). `module_scope` finds the
// smallest enclosing build module; llmKeyIndex feeds only in-scope blind files to the LLM. The floor +
// learned rules still ground repo-wide, so this is a cost bound, not a coverage loss. HostBus = no API key.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { module_scope } from "../../src/core/resolve/languages/index.js";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { llmKeyIndex } from "../../src/codebase/coupling/llm_key_index.js";
import { _resetKeyStoreMem } from "../../src/codebase/coupling/key_store.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";

let REPO: string;
const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

beforeEach(() => { REPO = mkdtempSync(join(tmpdir(), "scope-")); _resetKeyStoreMem(); set_host_bus(null); process.env.SEAM_PER_FILE_KEYS = "1"; });   // pin the per-file pass scoping (opt-in; default = matcher-only)
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); _resetKeyStoreMem(); set_host_bus(null); delete process.env.SEAM_PER_FILE_KEYS; });

describe("module_scope — smallest enclosing build module (registry markers + universal manifests)", () => {
  test("a Maven-style module → its dir prefix; the repo root has its own pom too (nearest wins)", () => {
    w("pom.xml", "<project/>"); w("modA/pom.xml", "<project/>"); w("modA/src/main/java/X.java", "class X {}");
    expect(module_scope(REPO, "modA/src/main/java/X.java")).toBe("modA/");
  });
  test("a package.json module → its dir prefix", () => {
    w("packages/ui/package.json", "{}"); w("packages/ui/src/a.ts", "export const a = 1;");
    expect(module_scope(REPO, "packages/ui/src/a.ts")).toBe("packages/ui/");
  });
  test("no enclosing manifest → '' (whole repo is one module)", () => {
    w("src/a.ts", "export const a = 1;");
    expect(module_scope(REPO, "src/a.ts")).toBe("");
  });
});

// Captures the batched per-file synthesis prompt ("discover-keys-batch"); returns no keys.
class BatchCapture extends HostBus {
  prompt = "";
  serve(tag: string, prompt: string): string { if (tag === "discover-keys-batch") this.prompt = prompt; return "[]"; }
}

describe("llmKeyIndex — per-file synthesis is bounded to the scope", () => {
  test("only the in-scope module's blind files reach the LLM; another module is excluded", async () => {
    w("modA/package.json", "{}"); w("modA/a.ts", "export function fa() { return cacheA.read('a'); }\n");   // blind, in scope
    w("modB/package.json", "{}"); w("modB/b.ts", "export function fb() { return storeB.read('b'); }\n");   // blind, OUT of scope
    const bus = new BatchCapture(); set_host_bus(bus);
    await llmKeyIndex(REPO, { llm: true, scope: "modA/" }, new EngineCtx());
    expect(bus.prompt).toContain("modA/a.ts");      // the anchor module's file was synthesised
    expect(bus.prompt).not.toContain("modB/b.ts");  // the other module was NOT fed to the LLM (warms lazily later)
  });
  test("SEAM_WARM_ADAPTERS=1 restores the whole-repo pass (both modules)", async () => {
    w("modA/package.json", "{}"); w("modA/a.ts", "export function fa() { return cacheA.read('a'); }\n");
    w("modB/package.json", "{}"); w("modB/b.ts", "export function fb() { return storeB.read('b'); }\n");
    const prev = process.env.SEAM_WARM_ADAPTERS; process.env.SEAM_WARM_ADAPTERS = "1";
    try {
      const bus = new BatchCapture(); set_host_bus(bus);
      await llmKeyIndex(REPO, { llm: true, scope: "modA/" }, new EngineCtx());
      expect(bus.prompt).toContain("modA/a.ts");
      expect(bus.prompt).toContain("modB/b.ts");    // whole-repo override → both modules fed
    } finally { if (prev === undefined) delete process.env.SEAM_WARM_ADAPTERS; else process.env.SEAM_WARM_ADAPTERS = prev; }
  });
});
