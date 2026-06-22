// Two-tier anchor probe (Lever 1) + shared-ctx (Lever 2). The probe ranks candidates by CALL/IMPORT
// connectedness and pays the expensive data-coupling overlay ONLY to RESCUE the would-be-isolated — a
// cross-stack-only anchor (a `$http` front-end → a Java `@GetMapping` backend, linked only by the shared
// `/api/orders` route, no import/call edge). The fixture exposes exactly that "isolated core" case.
import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { probe_anchor, select_anchor } from "../../src/codebase/anchor/anchor_select.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const repo = join(__dir, "..", "fixtures", "crossstack-route-repo");
const CONTROLLER = "backend/OrderController.java";   // cross-stack-only (route handler, no in-repo caller)
const ORDERS_PAGE = "frontend/OrdersPage.tsx";       // call-connected (imports formatOrders, mounted by App)

afterEach(() => { delete process.env.SEAM_PROBE_COUPLING; });

describe("probe_anchor: data-coupling rescues a cross-stack-only anchor", () => {
  test("the Java route handler is ISOLATED on the cheap (call/import) probe", async () => {
    const m = await probe_anchor(repo, CONTROLLER, "OrderController", { dataCoupling: false });
    expect(m).not.toBeNull();
    expect(m!.isolated).toBe(true);   // no in-repo caller, no shared-key edge → dead-ends at the anchor
  });

  test("…and is RESCUED (non-isolated, crosses the route boundary) with data-coupling on", async () => {
    const m = await probe_anchor(repo, CONTROLLER, "OrderController", { dataCoupling: true });
    expect(m).not.toBeNull();
    expect(m!.isolated).toBe(false);
    expect(m!.crossings).toBeGreaterThanOrEqual(1);   // couples to the front-end across /api/orders
  });

  test("a call/import-connected anchor needs NO coupling to look connected", async () => {
    const m = await probe_anchor(repo, ORDERS_PAGE, "OrdersPage", { dataCoupling: false });
    expect(m).not.toBeNull();
    expect(m!.isolated).toBe(false);   // App → OrdersPage → formatOrders is a real call chain
  });
});

describe("select_anchor: two-tier keeps the cross-stack anchor alive and pays coupling only to rescue", () => {
  // SEED the Java handler in (the lexical name-net is JS/TS-only; the real path surfaces it via embed
  // recall — a seed makes the test deterministic without the embedder).
  const seeds = [{ name: "OrderController", file: CONTROLLER, kind: "class" }];
  const opts = { llmExpand: false, judge: false, dataCoupling: true, seeds } as const;

  test("the rescued cross-stack anchor survives into the ranked pool, marked rescued", async () => {
    const sel = await select_anchor(repo, "list the user's orders", opts);
    const oc = sel.ranked.find((p) => p.name === "OrderController");
    expect(oc).toBeDefined();
    expect(oc!.rescued).toBe(true);                 // un-isolated only via the coupling rescue
    expect(oc!.metrics?.isolated).toBe(false);
  });

  test("selection is stable vs the old probe-everyone-with-coupling path", async () => {
    const twoTier = await select_anchor(repo, "list the user's orders", opts);
    process.env.SEAM_PROBE_COUPLING = "always";
    const always = await select_anchor(repo, "list the user's orders", opts);
    expect(twoTier.chosen?.name).toBe(always.chosen?.name);   // same anchor chosen
    // both keep the cross-stack handler connected (alive), regardless of which probe path
    const ocBoth = [twoTier, always].map((s) => s.ranked.find((p) => p.name === "OrderController")?.metrics?.isolated);
    expect(ocBoth).toEqual([false, false]);
  });
});
