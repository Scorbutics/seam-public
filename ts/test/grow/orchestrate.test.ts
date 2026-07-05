// DETERMINISTIC codebase grow (orchestrate.ts) — grow_to_terminals follows the resolved crossings to the
// footprint's terminals with NO LLM. (The former LLM move-picker `auto_orchestrate` / `--grow llm` was
// removed; the deterministic frontier walk reproduces its result offline, so this suite is host-bus-free.)
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";

describe("codebase deterministic grow", () => {
  // The deterministic grow (NO LLM) follows the resolved crossings to the footprint's terminals. From the
  // payments WRITER it must reach the admin PAGE (writer → payments → route → service → page), no host bus.
  test("grow_to_terminals reaches the UI terminal deterministically (no LLM)", async () => {
    const rrepo = join("test", "fixtures", "route-repo");
    const [data, hist]: [any, any[]] = await grow_to_terminals(rrepo, "backend/persist.ts", "persistPayment", { dataCoupling: true });
    expect(hist.length).toBeGreaterThan(0);                          // it actually expanded
    const files = new Set(data.nodes.map((n: any) => n.file));
    expect(files.has("app/dashboard/admin/payments/page.ts")).toBe(true);   // the terminal screen, reached with zero LLM
  });
});
