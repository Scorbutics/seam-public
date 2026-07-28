// THE HOST-BUS BRIDGE — the caller's model serving the CORE's LLM passes.
//
// `set_host_bus(...)` is how a Claude Code skill lends the live session's model, how the VS Code extension
// injects the editor's configured one, and how an MCP client answers by sampling. Until the bridge existed
// that model was invisible to the Rust core: `crates/seam-llm` could only spawn a local `claude`/`copilot`,
// so the whole flywheel — key discovery, carrier synthesis, receiver classification, route composition — was
// unreachable for every caller that had a model but no binary.
//
// The bridge is RECORD-AND-REPLAY, not a callback: the JS thread is blocked inside the synchronous addon call,
// so a callback would queue onto an event loop that cannot turn (a deadlock, presenting as a hang). These
// tests pin the two properties that makes the design correct — a pass IS served from the injected model, and a
// collecting round leaves NO trace.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { set_host_bus, HostBus } from "../../src/core/llm.js";
import { rustDiscover } from "../../src/codebase/grow/rust_discover.js";
import { loadAddon } from "../../src/codebase/rust_core.js";

let REPO: string, SHARED: string;

// The core's own discovery pass is `discover-key-matchers` — it asks for RULES (a token + verb shape it can
// re-execute deterministically), not for per-file key lists. That is the question this bus answers.
const RULES = JSON.stringify([
  { id: "r1", via: "channel", token: "customBus", verbs: ["fire"], kind: "event", role: "produces", name: "custombus-fire", description: "publishes on the project bus" },
  { id: "r2", via: "channel", token: "customBus", verbs: ["on"], kind: "event", role: "consumes", name: "custombus-on", description: "subscribes on the project bus" },
]);

class ScriptedBus extends HostBus {
  seen: { tag: string; prompt: string; model: string }[] = [];
  constructor(private reply: (tag: string) => string) { super(); }
  serve(tag: string, prompt: string, model: string): string {
    this.seen.push({ tag, prompt, model });
    return this.reply(tag);
  }
}

const storePath = () => join(REPO, ".seam", "key-adapters.json");
const rulesInStore = (): any[] => {
  if (!existsSync(storePath())) return [];
  try { return JSON.parse(readFileSync(storePath(), "utf-8")).rules ?? []; } catch { return []; }
};

beforeEach(() => {
  REPO = mkdtempSync(join(tmpdir(), "seam-hb-"));
  SHARED = mkdtempSync(join(tmpdir(), "seam-hb-shared-"));
  process.env.SEAM_ADAPTERS_DIR = SHARED;
  mkdirSync(join(REPO, "src"), { recursive: true });
  // A homemade event bus: no built-in adapter grounds it, so the floor is blind and the flywheel has a
  // genuine question to ask.
  writeFileSync(join(REPO, "src", "emit.ts"), "export function emitSync() { customBus.fire('sync'); }\n");
  writeFileSync(join(REPO, "src", "listen.ts"), "export function onSync() { customBus.on('sync', () => {}); }\n");
  loadAddon()!.syncSeamEnv([["SEAM_ADAPTERS_DIR", SHARED]]);
  loadAddon()!.resetCaches(REPO);
  set_host_bus(null);
});
afterEach(() => {
  set_host_bus(null);
  loadAddon()!.uninstallHostBus();
  rmSync(REPO, { recursive: true, force: true });
  rmSync(SHARED, { recursive: true, force: true });
  delete process.env.SEAM_ADAPTERS_DIR;
});

describe("host-bus bridge — the caller's model serves the core's passes", () => {
  test("a pass the core wants is answered by the INJECTED model, and the rule is learned", async () => {
    const bus = new ScriptedBus((tag) => (tag === "discover-key-matchers" ? RULES : "[]"));
    set_host_bus(bus);

    const learned = await rustDiscover(REPO, { scopeFiles: ["src/emit.ts", "src/listen.ts"] });

    // The core ASKED — with no claude/copilot involved. Before the bridge this list was empty.
    expect(bus.seen.some((s) => s.tag === "discover-key-matchers")).toBe(true);
    // …and the prompt it sent is the core's own, carrying the blind file it wants explained.
    expect(bus.seen.find((s) => s.tag === "discover-key-matchers")!.prompt).toContain("customBus");
    // …and the answer was ACCEPTED and persisted, which is the whole point: learn once, replay forever.
    expect(learned).toBeGreaterThan(0);
    expect(rulesInStore().some((r: any) => r.token === "customBus")).toBe(true);
  });

  test("no PROMPT is paid for twice, however many replay rounds it takes", async () => {
    const bus = new ScriptedBus((tag) => (tag === "discover-key-matchers" ? RULES : "[]"));
    set_host_bus(bus);
    await rustDiscover(REPO, { scopeFiles: ["src/emit.ts", "src/listen.ts"] });
    const asks = bus.seen.filter((s) => s.tag === "discover-key-matchers");
    // The pump re-runs the core to APPLY each answer, so the PASS executes several times. What must never
    // happen is paying for the same QUESTION twice — that is what the content-hash key buys, and a regression
    // here is a silently doubled LLM bill. (More than one DISTINCT prompt is normal and not a defect: the
    // discovery pass has a built-in retry, which a binary-backed run pays for too.)
    expect(new Set(asks.map((a) => a.prompt)).size).toBe(asks.length);
  });

  test("a DECLINED pass leaves no trace — nothing learned, nothing cached as a negative", async () => {
    // A host that answers nothing useful. The danger is not that we learn nothing; it is that we cache
    // "nothing" as a VERDICT and never ask again. `.seam` must come out clean.
    const bus = new ScriptedBus(() => "[]");
    set_host_bus(bus);
    const learned = await rustDiscover(REPO, { scopeFiles: ["src/emit.ts", "src/listen.ts"] });
    expect(learned).toBe(0);
    expect(rulesInStore()).toEqual([]);
  });

  test("with NO host bus the bridge is INERT — nothing is installed, nothing recorded", () => {
    set_host_bus(null);
    // Deliberately NOT calling rustDiscover here: with no bus and no injected model it would spawn a real
    // `claude`, which is neither hermetic nor fast. The claim is narrower and is the one that matters — the
    // bridge does not install itself, so the local-binary path runs exactly as it did before.
    expect(loadAddon()!.takeHostRecorded()).toEqual([]);
  });
});
