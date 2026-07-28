// RUST-CORE BOUNDARY PARITY — the three ways the addon silently disagreed with the TS grow, each pinned here.
//
// The Rust core is a SECOND engine for the same query, so every divergence looks like an engine bug rather than
// a boundary bug, and none of them fail loudly: they return a well-formed graph that is simply the wrong one.
// The three classes, all found in the same audit:
//   1. OPTIONS NOT CROSSING — the addon hard-coded its containment (hub fan, up-hop, exclusions) while TS read
//      `opts`, so `--exclude`/`--include-tests`/`upHop` were honoured by one engine and ignored by the other.
//      The tell was an A/B that returned byte-identical results for OPPOSITE flags.
//   2. THE ANSWER CACHE NOT KEYED ON THOSE OPTIONS — once (1) is fixed, a knob that changes the grown set MUST
//      be in the P5 cache key, or the second call serves the first call's answer. This is strictly worse than
//      (1): it is order-dependent, so it reproduces only when the two calls run in one process.
//   3. ENV NOT CROSSING — bun's `process.env` is a JS object, so a runtime flag flip never reaches Rust's
//      `std::env`; the addon answered under the environment it saw at process start.
// Hermetic tmp repo; guarded on tree-sitter + on the addon existing (neither is present in the .vsix / offline CI).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { loadAddon } from "../../src/codebase/rust_core.js";
import { resolveStructuralKnobs } from "../../src/codebase/grow/structural_knobs.js";

const repo = join(tmpdir(), "seam-rustknobs-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

// The addon is built out-of-band (cargo); skip rather than fail where it is absent.
const addonPresent = (): boolean => { try { return !!loadAddon(); } catch { return false; } };
const files = (data: any): string[] => [...new Set((data?.nodes ?? []).map((n: any) => String(n.file)))].sort() as string[];

beforeAll(() => {
  w("package.json", `{"name":"rk","version":"1.0.0"}\n`);
  w("src/core.ts", `export function core(id: string) { return id; }\n`);
  // A consumer under a nameable folder AND a test-file consumer — the two things exclusion is asked about.
  w("src/util/caller.ts", `import { core } from "../core";\nexport function caller(id: string) { return core(id); }\n`);
  w("src/core.test.ts", `import { core } from "./core";\nexport function spec() { return core("x"); }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

// The grow runs with SEAM_RUST_CORE forced ON, whatever the ambient default is — these assertions are about the
// ADDON's behaviour, so they must not quietly become assertions about the TS engine if the default ever moves.
async function growRust(opts: Record<string, unknown>): Promise<any> {
  const saved = process.env.SEAM_RUST_CORE;
  process.env.SEAM_RUST_CORE = "1";
  try {
    const [data] = await grow_to_terminals(repo, "src/core.ts", "core", { maxNodes: 40, dataCoupling: false, structuralGrow: true, ...opts } as any);
    return data;
  } finally {
    if (saved === undefined) delete process.env.SEAM_RUST_CORE; else process.env.SEAM_RUST_CORE = saved;
  }
}

describe("Rust core — the grow options cross the napi boundary", () => {
  test("includeTests reaches the addon: the test consumer is excluded by default and kept when asked", async () => {
    if (!available() || !addonPresent()) return;
    const off = files(await growRust({ includeTests: false }));
    const on = files(await growRust({ includeTests: true }));
    // The A/B is the point: while the addon hard-coded `Exclusion::new(&[], false)` these two were IDENTICAL.
    expect(off).not.toContain("src/core.test.ts");
    expect(on).toContain("src/core.test.ts");
  }, 60_000);

  test("excludeDirs reaches the addon: a named folder's consumer is dropped", async () => {
    if (!available() || !addonPresent()) return;
    const kept = files(await growRust({ excludeDirs: [] }));
    const dropped = files(await growRust({ excludeDirs: ["util"] }));
    expect(kept).toContain("src/util/caller.ts");
    expect(dropped).not.toContain("src/util/caller.ts");
  }, 60_000);
});

// The regression this guards is a TRAP rather than a bug you would notice: the addon's P5 answer-cache key was
// built from `symbol|dataCoupling|maxSteps|maxNodes`, which was complete only while those were the ONLY inputs.
// The moment the containment knobs became real inputs, two grows differing only by a knob collided on one key —
// so the SECOND call is served the FIRST call's graph. It reproduces only in-process, which is exactly where a
// warm engine lives.
describe("Rust core — the answer cache is keyed on the options, not just the node budget", () => {
  test("two grows differing ONLY by includeTests do not collide in the answer cache", async () => {
    if (!available() || !addonPresent()) return;
    // Order matters: run the EXCLUDING grow first so a key collision would serve its (smaller) graph to the
    // second call — the direction that silently loses nodes rather than gaining them.
    const off = files(await growRust({ includeTests: false }));
    const on = files(await growRust({ includeTests: true }));
    expect(on).not.toEqual(off);
    expect(on).toContain("src/core.test.ts");
  }, 60_000);
});

describe("Rust core — SEAM_* env reaches the addon after a runtime flip", () => {
  test("syncSeamEnv mirrors a set value and removes an unset one", () => {
    if (!addonPresent()) return;
    const addon = loadAddon();
    // readSeamEnv is the read-back seam for exactly this: without it, "did the flag cross?" is only observable
    // as a graph difference, which cannot distinguish "not synced" from "synced but ignored".
    if (typeof addon.readSeamEnv !== "function") return;
    addon.syncSeamEnv([["SEAM_PARITY_PROBE", "1"]]);
    expect(addon.readSeamEnv("SEAM_PARITY_PROBE")).toBe("1");
    addon.syncSeamEnv([]);                                   // the host no longer has it → it must be REMOVED
    expect(addon.readSeamEnv("SEAM_PARITY_PROBE")).toBeNull();
  });

  test("only SEAM_-prefixed keys are mirrored (this is not a general env-write channel)", () => {
    if (!addonPresent()) return;
    const addon = loadAddon();
    if (typeof addon.readSeamEnv !== "function") return;
    addon.syncSeamEnv([["NOT_A_SEAM_VAR", "1"]]);
    expect(addon.readSeamEnv("NOT_A_SEAM_VAR")).toBeNull();
  });
});

// The resolver is the single source of truth both engines read; if it drifts, they drift together rather than
// apart, which is the whole point. These pin the precedence rules that were previously inline in the TS wave.
describe("structural knobs — opts beat env beat default", () => {
  test("an explicit opt wins over the env var", () => {
    const saved = process.env.SEAM_HUB_FAN;
    process.env.SEAM_HUB_FAN = "7";
    try {
      expect(resolveStructuralKnobs({}).hubFan).toBe(7);
      expect(resolveStructuralKnobs({ hubFan: 20 }).hubFan).toBe(20);
    } finally {
      if (saved === undefined) delete process.env.SEAM_HUB_FAN; else process.env.SEAM_HUB_FAN = saved;
    }
  });

  test("a structural grow defaults upHop to 2 — it is the sole container once the intent field is gone", () => {
    expect(resolveStructuralKnobs({ structuralGrow: true }).upHop).toBe(2);
    expect(resolveStructuralKnobs({ structuralGrow: false }).upHop).toBe(0);
  });

  test("hubCollapse subsumes hubGate and ubiquity (one mechanism, not three flags)", () => {
    expect(resolveStructuralKnobs({ hubCollapse: true, hubGate: false, ubiquity: false }).hubGate).toBe(true);
    expect(resolveStructuralKnobs({ hubCollapse: true, hubGate: false, ubiquity: false }).ubiquity).toBe(true);
    expect(resolveStructuralKnobs({ hubCollapse: false, hubGate: false, ubiquity: false }).hubGate).toBe(false);
  });
});
