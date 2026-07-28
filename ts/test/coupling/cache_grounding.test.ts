// CACHE coupling (a writer setItem('k') ⇄ a reader getItem('k') of the SAME key) is learned-only — no
// built-in adapter — and previously had only MATCHER-LEVEL coverage (the IR grounds a synthetic index). This
// proves the END-TO-END capability: primed `call` matchers, applied offline (regex, no LLM), couple a writer
// file to a reader file across the shared cache key, materialising the `cache` boundary node (archetype-typed,
// not GENERIC). The `cache` kind semantics survive having no detection adapter via the ARCHETYPE registry.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kindOf } from "../../src/codebase/coupling/adapters/index.js";
import { build_module_graph } from "../helpers/scan.js";
import { _resetMatcherCacheMem } from "../helpers/coupling.js";
import { available } from "../../src/codebase/atoms.js";

describe("the `cache` kind resolves to its archetype (cache boundary + write/read edges), not GENERIC", () => {
  test("kindOf('cache') carries the archetype semantics, learned-only detection notwithstanding", () => {
    const k = kindOf("cache");
    expect(k.nodeKind).toBe("cache");
    expect([k.produceEdge, k.consumeEdge]).toEqual(["cache-write", "cache-read"]);
    expect(k.handlerEdge).toBeUndefined();   // a cache read continues UPSTREAM toward display, not a downstream handler
  });
});

// localStorage.setItem('compactMode', …) ⇄ localStorage.getItem('compactMode') via primed `call` matchers.
const CACHE_MATCHERS = {
  schema: 1,
  matchers: [
    { via: "call", token: "setItem", argIndex: 0, kind: "cache", role: "produces", name: "ls-set", description: "localStorage.setItem('k', v)" },
    { via: "call", token: "getItem", argIndex: 0, kind: "cache", role: "consumes", name: "ls-get", description: "localStorage.getItem('k')" },
  ],
};

describe("learned cache adapter (primed `.seam`) — a writer of a cache key reaches the reader of the same key", () => {
  const REPO = join(tmpdir(), "seam-cache-learned-" + process.pid);
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    write("settings/writePrefs.js",
      "export function setCompact(on) {\n  localStorage.setItem('compactMode', on ? '1' : '0');\n}\n");
    write("layout/readPrefs.js",
      "export function isCompact() {\n  return localStorage.getItem('compactMode') === '1';\n}\n");
    mkdirSync(join(REPO, ".seam"), { recursive: true });
    writeFileSync(join(REPO, ".seam", "key-matchers.json"), JSON.stringify(CACHE_MATCHERS));
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("setItem('compactMode') couples to getItem('compactMode') across files, via the cache boundary", async () => {
    if (!available()) return;
    _resetMatcherCacheMem();
    const g = await build_module_graph(REPO, "settings/writePrefs.js", { dataCoupling: true });
    const files = (g.nodes ?? []).map((n: any) => n.file);
    expect(files.some((f: string) => f.endsWith("layout/readPrefs.js"))).toBe(true);                    // writer → reader of the same key
    expect((g.nodes ?? []).some((n: any) => n.kind === "cache" && n.symbol === "compactMode")).toBe(true);   // cache boundary materialised (archetype-typed)
  });
});
