// CONCERN-MAP FLYWHEEL (Phase 4) — the LLM labels each MODULE against the closed side-concern vocabulary
// ONCE, caches to `.seam/concern-map.json`, and a warm run applies it with NO LLM. At the border, a candidate
// in a labelled side-concern module (bearing no crossing) auto-DROPs. Proven hermetically with an INJECTED
// HostBus (offline; resolve_backend returns the host bus, so llmAvailable is true without a real CLI):
//   • learn-once → cache → warm reload does NOT re-call the LLM (the flywheel);
//   • out-of-vocabulary labels are discarded (grounding);
//   • the border auto-DROPs a labelled-concern node WITHOUT asking the judge, KEEPs a crossing-bearer in a
//     labelled module (I4), and — with no map — changes nothing.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { HostBus, set_host_bus } from "../../src/core/llm.js";
import { loadOrBuildConcernMap, concernOf, _resetConcernMapMem, CONCERN_MAP_REL } from "../../src/codebase/grow/concern_map.js";
import { concernDropSentence, isConcernLabel, CONCERNS } from "../../src/codebase/grow/concerns.js";
import { _llmPruneInShape, type BandCtx } from "../../src/codebase/grow/orchestrate.js";

afterEach(() => { set_host_bus(null); _resetConcernMapMem(); });

const mkRepo = (): string => {
  const repo = join(tmpdir(), "seam-concern-" + process.pid + "-" + Math.round(performance.now()));
  const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
  w("package.json", `{ "name": "concern-fixture", "version": "1.0.0" }\n`);
  w("logging/logger.ts", `export function log(m: string) { if (process.env.DEBUG) console.log(m); }\n`);
  w("notify/notifier.ts", `export function notify(id: string) { return { sent: true, id }; }\n`);
  w("booking/service.ts", `export function book(id: string) { return { ok: true, id }; }\n`);
  return repo;
};

// labels a module by its directory name; returns a bogus label for `booking/` to prove grounding discards it.
class ConcernBus extends HostBus {
  calls = 0;
  serve(tag: string, prompt: string): string {
    if (tag !== "concern-map") return "[]";
    this.calls++;
    const out: any[] = [];
    for (const line of prompt.split("\n")) {
      const m = line.match(/^\[(\d+)\]\s+(\S+)/);
      if (!m) continue;
      const dir = m[2];
      const label = /logging\//.test(dir) ? "logging" : /notify\//.test(dir) ? "notification" : /booking\//.test(dir) ? "totally-made-up" : "none";
      out.push({ id: m[1], label });
    }
    return JSON.stringify(out);
  }
}

describe("concern map — learn once, cache, reload without the LLM", () => {
  test("learns module labels, discards out-of-vocab, persists, and warm-reloads LLM-free", async () => {
    const repo = mkRepo();
    try {
      const bus = new ConcernBus();
      set_host_bus(bus);
      const map = await loadOrBuildConcernMap(repo, {}, undefined);
      expect(map.get("logging/")).toBe("logging");
      expect(map.get("notify/")).toBe("notification");
      expect(map.has("booking/")).toBe(false);          // "totally-made-up" is out of vocab → discarded (grounding)
      expect(bus.calls).toBe(1);                          // learned in ONE batched call
      expect(existsSync(join(repo, CONCERN_MAP_REL))).toBe(true);   // persisted to .seam

      // WARM reload (fresh memo, fresh bus) — reads the cache, does NOT re-call the LLM.
      _resetConcernMapMem();
      const bus2 = new ConcernBus();
      set_host_bus(bus2);
      const warm = await loadOrBuildConcernMap(repo, {}, undefined);
      expect(warm.get("logging/")).toBe("logging");
      expect(warm.get("notify/")).toBe("notification");
      expect(bus2.calls).toBe(0);                         // flywheel: warm run is LLM-free
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("stable-floor probe never learns (I5)", async () => {
    const repo = mkRepo();
    try {
      const bus = new ConcernBus();
      set_host_bus(bus);
      const map = await loadOrBuildConcernMap(repo, {}, { stableFloor: true } as any);
      expect(bus.calls).toBe(0);       // no LLM in the throwaway probe
      expect(map.size).toBe(0);        // cold + no learn → empty (I3-style)
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("concernOf maps a file to its module's concern (null for none/unlabelled)", () => {
    const map = new Map([["logging/", "logging"], ["notify/", "notification"]]);
    expect(concernOf(map, "/r", "logging/logger.ts")).toBe("logging");
    expect(concernOf(map, "/r", "notify/notifier.ts")).toBe("notification");
    expect(concernOf(map, "/r", "booking/service.ts")).toBeNull();
    expect(concernOf(map, "/r", undefined)).toBeNull();
  });
});

// ── border apply: the partition auto-DROPs a labelled concern node, keeps a crossing-bearer (I4) ──
class Recording extends HostBus {
  asked: string[] = [];
  serve(tag: string, prompt: string): string {
    if (tag !== "grow-border") return "[]";
    const out: any[] = [];
    for (const line of prompt.split("\n")) { const m = line.match(/^\[(\d+)\]\s+(\S+)/); if (!m) continue; this.asked.push(m[2]); out.push({ id: m[1], keep: true }); }
    return JSON.stringify(out);
  }
}
const graph = () => ({
  anchor: { id: "n1" },
  nodes: [
    { id: "n1", symbol: "anchor", file: "booking/service.ts", kind: "function", concern: null },
    { id: "concernNode", symbol: "log", file: "logging/logger.ts", kind: "function", concern: "logging" },      // labelled concern → auto-DROP
    { id: "concernCross", symbol: "auditWrite", file: "logging/logger.ts", kind: "function", concern: "logging", coupling: true },   // labelled BUT crossing → I4 keep
    { id: "mid", symbol: "maybe", file: "booking/other.ts", kind: "function", concern: null },                  // no label → residual → SLM
  ],
  edges: [{ from: "n1", to: "concernNode", kind: "call", provenance: "RESOLVED_FULL" }, { from: "n1", to: "concernCross", kind: "call", provenance: "RESOLVED_FULL" }, { from: "n1", to: "mid", kind: "call", provenance: "RESOLVED_FULL" }],
  blindspots: [],
});
const concernBand = (): BandCtx => ({ residual: false, field: () => 0, ubiquity: () => 0, hi: 0.34, lo: 0.2, fan: 3, concern: (n: any) => n.concern ?? null });

describe("concern map — border apply (I4-safe auto-drop)", () => {
  test("a labelled concern node auto-drops WITHOUT the judge; a crossing-bearer in the same module is kept", async () => {
    const rec = new Recording();
    set_host_bus(rec);
    const data: any = graph();
    const decided = new Map<string, boolean>([["n1", true]]);
    const inScope = await _llmPruneInShape(data, "n1", { intent: "book" }, decided, concernBand());
    expect(rec.asked).toEqual(["maybe"]);                 // only the unlabelled middle reaches the judge
    expect(rec.asked).not.toContain("log");               // concern node — not judged
    expect(inScope.has("concernNode")).toBe(false);       // …auto-DROPPED
    expect(inScope.has("concernCross")).toBe(true);       // I4: crossing beats the concern label
    expect(rec.asked).not.toContain("auditWrite");        // …and it wasn't judged either (auto-KEEP)
    expect(inScope.has("mid")).toBe(true);                // residual kept by the judge
  });

  test("with no concern label, the (formerly concern) node reaches the judge — the label is what drops it", async () => {
    const rec = new Recording();
    set_host_bus(rec);
    const data: any = graph();
    for (const n of data.nodes) n.concern = null;         // empty map → concern auto-drop is inert
    const decided = new Map<string, boolean>([["n1", true]]);
    await _llmPruneInShape(data, "n1", { intent: "book" }, decided, concernBand());
    // `auditWrite` still auto-keeps via `coupling` (I4, independent of concern); `log` now reaches the judge.
    expect(rec.asked.sort()).toEqual(["log", "maybe"]);
    expect(rec.asked).toContain("log");
  });
});

describe("concern registry — the DROP sentence is derived from the closed vocab", () => {
  test("concernDropSentence lists the registry kinds; isConcernLabel validates the closed set", () => {
    const s = concernDropSentence();
    for (const c of CONCERNS) expect(s).toContain(c.name);
    expect(isConcernLabel("logging")).toBe(true);
    expect(isConcernLabel("none")).toBe(false);   // `none` is not a concern
    expect(isConcernLabel("bogus")).toBe(false);
  });
});
