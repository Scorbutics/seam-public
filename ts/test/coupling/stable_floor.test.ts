// STABLE-FLOOR footprint pre-grow (warm-settle fix). The footprint pre-grow must ground from the
// DETERMINISTIC floor ONLY — never the LEARNED adapters that accumulate in .seam — else the footprint
// EXPANDS every run as adapters are learned and warm never settles. Contract: with `ctx.stableFloor`, a
// coupling that exists ONLY via a learned matcher is NOT surfaced; without it, the learned matcher grounds
// it as normal. (The end-to-end perf was measured on cal.com — 97s→37s warm; this pins the mechanism.)
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCoupling, persistMatchers, validateMatcher } from "../helpers/coupling.js";
import { available } from "../../src/codebase/atoms.js";
import { loadAddon } from "../../src/codebase/rust_core.js";

const resetStore = (repo: string) => loadAddon()!.resetCaches(repo);

let REPO: string, SHARED: string;
const ANCHOR = `export function emitSync() { customBus.fire('sync'); }\n`;   // grounds ONLY via a learned channel rule

beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "sf-repo-")); SHARED = mkdtempSync(join(tmpdir(), "sf-shared-"));
  process.env.SEAM_ADAPTERS_DIR = SHARED; loadAddon()!.syncSeamEnv([["SEAM_ADAPTERS_DIR", SHARED]]); resetStore(REPO);
  mkdirSync(join(REPO, "src"), { recursive: true });
  writeFileSync(join(REPO, "src", "anchor.ts"), ANCHOR);
  writeFileSync(join(REPO, "src", "other.ts"), `export function onSync() { customBus.on('sync', () => {}); }\n`);   // the consumer
  // a LEARNED channel rule pair (NOT a built-in floor adapter) → 'event sync' grounds producer⇄consumer
  persistMatchers(REPO, [
    validateMatcher({ via: "channel", token: "customBus", verbs: ["fire"], kind: "event", role: "produces" })!,
    validateMatcher({ via: "channel", token: "customBus", verbs: ["on"], kind: "event", role: "consumes" })!,
  ]);
});
afterEach(() => { rmSync(REPO, { recursive: true, force: true }); rmSync(SHARED, { recursive: true, force: true }); delete process.env.SEAM_ADAPTERS_DIR; resetStore(REPO); });

describe("stable-floor footprint pre-grow", () => {
  // `stableFloor` is an explicit parameter in the core (it was an EngineCtx field in TypeScript).
  const resolve = (stableFloor: boolean) => resolveCoupling(REPO, "a0", "src/anchor.ts", ANCHOR, 0, 99, 0, stableFloor);

  test("WITHOUT stableFloor: the learned channel rule grounds the 'sync' coupling", async () => {
    if (!available()) return;   // resolveCoupling needs tree-sitter for the complement unit
    const r = resolve(false);
    expect(r.nodes.some((n) => n.symbol === "sync")).toBe(true);
  });

  test("WITH stableFloor: the learned rule is ignored → no 'sync' coupling (deterministic floor only)", async () => {
    if (!available()) return;
    const r = resolve(true);
    expect(r.nodes.some((n) => n.symbol === "sync")).toBe(false);
  });
});
