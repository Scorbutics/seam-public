// CHAINING: the matcher synth must be fed the files where the PER-FILE pass found keys FIRST, not an
// arbitrary alphabetical slice of blind files — otherwise a recurring pattern (e.g. localStorage in
// component files that sort AFTER the api/ routes) is never seen, never generalised into a rule, and the
// per-file pass has to list it literally forever. Here a per-file HIT is primed on an alphabetically-LATE
// file; we capture the matcher-synth prompt and assert that file appears BEFORE the early blind filler.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { llmKeyIndex } from "../../src/codebase/coupling/llm_key_index.js";
import { learnKeyMatchers } from "../../src/codebase/coupling/key_matcher.js";
import { persistFileKeys, _resetKeyStoreMem } from "../../src/codebase/coupling/key_store.js";
import { EngineCtx } from "../../src/codebase/engine_ctx.js";

let REPO: string, SHARED: string;
const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };

// Captures the matcher-synth prompt; returns no keys/rules (we only assert WHICH files it was shown).
class CaptureBus extends HostBus {
  matcherPrompt = "";
  serve(tag: string, prompt: string): string {
    if (tag === "discover-key-matchers") { this.matcherPrompt = prompt; return "[]"; }
    return "[]";   // per-file batch ("discover-keys-batch") → no keys for the filler
  }
}

beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "chain-repo-")); SHARED = mkdtempSync(join(tmpdir(), "chain-shared-"));
  process.env.SEAM_ADAPTERS_DIR = SHARED;
  _resetKeyStoreMem(); set_host_bus(null);
});
afterEach(() => {
  rmSync(REPO, { recursive: true, force: true }); rmSync(SHARED, { recursive: true, force: true });
  delete process.env.SEAM_ADAPTERS_DIR; set_host_bus(null); _resetKeyStoreMem();
});

describe("matcher synth is fed the per-file-hit files first (chaining)", () => {
  test("an alphabetically-LATE file with a primed per-file hit reaches the matcher prompt before early blind filler", async () => {
    // early blind filler (sorts first, no coupling) + a late file that the per-file pass "found" keys in
    write("a00_early.ts", "export const x = 1;\n");
    write("a01_early.ts", "export const y = 2;\n");
    const storeText = "localStorage.setItem('compactMode', v);\nexport const read = () => localStorage.getItem('compactMode');\n";
    write("zz_store.ts", storeText);

    // prime the per-file cache so zz_store.ts is a HIT (no per-file LLM needed) — keyed `<rel> <sha1(text)>`
    const ck = `zz_store.ts ${createHash("sha1").update(storeText).digest("hex")}`;
    persistFileKeys(REPO, ck, { name: "store-keys", description: "", keys: [{ kind: "cache", value: "compactMode", line: 0, produces: true }] });

    const bus = new CaptureBus();
    set_host_bus(bus);
    await llmKeyIndex(REPO, { llm: true }, new EngineCtx());

    expect(bus.matcherPrompt).toContain("zz_store.ts");                                   // the per-file-hit file was shown to the matcher synth
    expect(bus.matcherPrompt.indexOf("zz_store.ts")).toBeLessThan(bus.matcherPrompt.indexOf("a00_early.ts"));   // …and FIRST (chained), before the early filler
  });
});

describe("matcher synth uses BREADTH (many files per call), not depth", () => {
  test("six 4 KB files all reach one matcher prompt — the old 8 KB/4 KB-per-file cap fit only ~2", async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ file: `file${i}.ts`, text: "/*x*/ ".repeat(700) + `\n// marker file${i}\n` }));   // ~4 KB each
    const bus = new CaptureBus();
    set_host_bus(bus);
    await learnKeyMatchers(REPO, files, { llm: true }, new EngineCtx());
    // each file is sliced to matcherPerFile (1.4 KB) so all 6 fit matcherSnippetCap (16 KB); the old config
    // (perFile 4 KB / cap 8 KB) would have stopped at the 2nd. Assert a LATE file is present.
    expect(bus.matcherPrompt).toContain("file5.ts");
  });
});
