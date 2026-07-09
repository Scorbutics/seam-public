// AGENT RENDER (Phase 3) — the token-budgeted `--format agent` projection. renderAgent is a PURE function of the
// emitted model (zero LLM, no repo), so it is tested here against hand-crafted models — fully deterministic, no
// tree-sitter / embeddings guards needed. Three contracts: (1) the sections are present + ordered; (2) under a
// tight budget the OFF/supporting region lines crop (with a note) while the exempt sections — spine, hubs,
// frontier, blindspots — stay INTACT (I3); (3) with no spine tier it falls back to shell ordering.
import { describe, expect, test } from "bun:test";
import { renderAgent } from "../../src/codebase/llm_context.js";

// a rich model: a spine seam, several supporting + many off seams (so the full render is large), a collapsed hub,
// a decision-point frontier, and a blindspot. Mirrors the emit shape (clusters[0].seams[], top-level frontier/blindspots).
const seam = (id: string, tier: string, label: string, extra: any = {}) => ({
  id, label, tier, region: { shell: 1, direction: "down" },
  primary: { file: `src/${id}.ts`, line: 10, symbol: label },
  hunks: [{ id: `${id}h`, file: `src/${id}.ts`, start: 10, role: tier === "spine" ? "core" : "link", label, ...extra }],
});
const makeModel = (opts: { spine?: boolean; offN?: number } = {}) => {
  const seams: any[] = [];
  if (opts.spine ?? true) seams.push(seam("anchor", "spine", "createBooking"));
  seams.push(seam("svc", "supporting", "bookingService"));
  for (let i = 0; i < (opts.offN ?? 12); i++) seams.push(seam(`off${i}`, "off", `offConcern${i}`));
  // give one supporting seam a collapsed-hub hunk (Phase 1 marker) + a crossing
  seams[opts.spine === false ? 0 : 1].hunks.push({ id: "hubh", file: "util/myString.ts", start: 3, role: "environment", label: "MyString", hub: { reason: "ubiquity", fan: 9, sampleConsumers: ["a/a.ts", "b/b.ts", "c/c.ts"] } });
  if (opts.spine ?? true) seams[0].writes = ["bookings"];
  return {
    mode: "codebase", anchor: "n1", resolutionQuality: "FULL",
    clusters: [{ id: "g1", intent: "createBooking", seams }],
    edges: [{ from: "svch", to: "anchorh", kind: "call" }],
    frontier: [{ id: "fx", symbol: "record", file: "telemetry/telemetry.ts", kind: "function", reachedVia: "used by bookingService", score: 0.04, cutBy: "decision" }],
    frontierCut: 2,
    blindspots: [{ node: "dispatch", mechanism: "string-dispatch", evidence: "dynamic handler lookup", candidates: [] }],
    unresolved: [],
  };
};

describe("renderAgent — sections, ordering, budget cropping, fallback", () => {
  test("full render: header · spine · region · hubs · frontier · blindspots, in order", () => {
    const out = renderAgent(makeModel(), { tokenBudget: 4000, intent: "how are bookings created" });
    for (const h of ["# Agent map", "## Spine", "## Region", "## Collapsed hubs", "## Frontier", "## Blindspots"])
      expect(out).toContain(h);
    // order: spine before region before frontier before blindspots
    expect(out.indexOf("## Spine")).toBeLessThan(out.indexOf("## Region"));
    expect(out.indexOf("## Region")).toBeLessThan(out.indexOf("## Frontier"));
    expect(out.indexOf("## Frontier")).toBeLessThan(out.indexOf("## Blindspots"));
    // the deepen recipe is stated ONCE (carrying the intent to redirect), not restated per frontier line
    expect(out).toContain("deepen any: seam --grow-from <file>#<symbol> --intent \"how are bookings created\"");
    expect(out).toContain("record (telemetry/telemetry.ts)");   // the frontier entry itself (no per-line invocation)
    // the hub is collapsed with fan + sample consumers; the crossing key shows on the spine
    expect(out).toContain("hub: ubiquity, fan 9");
    expect(out).toContain("[crossing: bookings]");
    expect(out).toContain("(+2 more decision point(s)");
  });

  test("a hub wiring many seams is listed ONCE, not per-seam (dedup — the Acme BookingsBean bug)", () => {
    const model = makeModel();
    // the SAME hub-marked hunk appears in 12 seams (a hub wires many) — the naive scan listed it 12×.
    const hubHunk = { id: "beanh", file: "cdi/bookings/BookingsBean.java", start: 3, role: "core", label: "BookingsBean", hub: { reason: "fan", fan: 14, sampleConsumers: ["a.java", "b.java"] } };
    for (let i = 0; i < 12; i++) model.clusters[0].seams.push({ id: `wire${i}`, label: `wire${i}`, tier: "off", region: { shell: 2, direction: "up" }, primary: { file: `w${i}.java`, line: 1, symbol: `wire${i}` }, hunks: [hubHunk] });
    const out = renderAgent(model, { tokenBudget: 8000, intent: "how are bookings managed" });
    expect((out.match(/BookingsBean.*hub: fan, fan 14/g) ?? []).length).toBe(1);   // exactly one collapsed-hub line
  });

  test("tight budget: off/supporting region lines crop (with a note); spine, hubs, frontier, blindspots stay", () => {
    const model = makeModel({ offN: 40 });   // a big off-path region → the full render blows the budget
    const budget = 350;
    const out = renderAgent(model, { tokenBudget: budget, intent: "how are bookings created" });
    // EXEMPT sections survive the crop (I3)
    expect(out).toContain("## Spine");
    expect(out).toContain("createBooking");
    expect(out).toContain("hub: ubiquity, fan 9");
    expect(out).toContain("record (telemetry/telemetry.ts)");   // frontier entry survives the crop (exempt)
    expect(out).toContain("## Blindspots");
    expect(out).toContain("string-dispatch");
    // the off-path region was CROPPED to a relevance-ranked HEAD and SAID SO (not silently dropped, not a bare count)
    expect(out).toMatch(/off-path \(top \d+ of \d+ by intent relevance/);
    // and it actually shrank vs the uncropped render
    const full = renderAgent(model, { tokenBudget: 100000, intent: "how are bookings created" });
    expect(out.length).toBeLessThan(full.length);
  });

  // INTENT CROP AT RENDER — the cropped region head is the most intent-RELEVANT seams (not the nearest/arbitrary),
  // so a structural union (grown intent-free for cache reuse) is tightened to the on-intent subset at render.
  test("tight budget: the region HEAD is ranked by intent relevance (on-intent surfaces, off-intent tail cropped)", () => {
    const model = makeModel({ offN: 0 });
    // 30 off seams: one clearly on-intent (high relevance), the rest low — only the head should survive the crop.
    for (let i = 0; i < 30; i++) model.clusters[0].seams.push({
      id: `o${i}`, label: `offConcern${i}`, tier: "off", relevance: i === 7 ? 0.95 : 0.5 - i * 0.01,
      region: { shell: 2, direction: "up" }, primary: { file: `o/o${i}.ts`, line: 1, symbol: `offConcern${i}` },
      hunks: [{ id: `o${i}h`, file: `o/o${i}.ts`, start: 1, role: "link", label: `offConcern${i}` }],
    });
    const out = renderAgent(model, { tokenBudget: 350, intent: "how are bookings created" });
    expect(out).toMatch(/off-path \(top \d+ of 30 by intent relevance/);
    expect(out).toContain("offConcern7");        // the high-relevance seam is in the head
    expect(out).not.toContain("offConcern29");    // a low-relevance one is cropped
  });

  test("no spine tier → falls back to shell ordering (no Spine section)", () => {
    const out = renderAgent(makeModel({ spine: false }), { tokenBudget: 4000 });
    expect(out).not.toContain("## Spine");
    expect(out).toContain("## Region (by shell");
    expect(out).toContain("bookingService");
  });

  test("many shared-key-fanout blindspots COLLAPSE to one summary (keep the keys + directive, not N lines)", () => {
    const model = makeModel();
    // a coupling-heavy repo: dozens of shared-key boundaries + one real per-node lead
    (model as any).blindspots = [
      ...Array.from({ length: 30 }, (_, i) => ({ node: `dc${i}`, mechanism: "shared-key-fanout",
        evidence: `'${["members", "admin", "payments"][i % 3]}' (db-table) written in ${i} files`, candidates: [{ symbol: ["members", "admin", "payments"][i % 3], provenance: "SUGGESTED" }] })),
      { node: "dispatch", mechanism: "string-dispatch", evidence: "dynamic handler lookup", candidates: [] },
    ];
    const out = renderAgent(model, { tokenBudget: 4000, intent: "x" });
    // the 30 fanout lines became ONE summary with the count + the distinct keys + the cross-from-other-side directive
    expect(out).toMatch(/30 shared-key boundary crossing\(s\)/);
    expect(out).toContain("members");
    expect(out.toLowerCase()).toContain("other side");
    // the non-fanout lead is still shown per-node (not collapsed)
    expect(out).toContain("string-dispatch");
    // and the section did not blow up: at most a couple of fanout-related lines, not 30
    expect((out.match(/shared-key/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  test("region DEDUPES by symbol identity — a bean wired into N seams renders ONCE, not N× (Acme BookingsBean 4×)", () => {
    const model = makeModel({ offN: 0 });
    for (let i = 0; i < 4; i++) model.clusters[0].seams.push({
      id: `dupe${i}`, label: "BookingsBean", tier: "supporting", region: { shell: 2, direction: "down" },
      primary: { file: "cdi/BookingsBean.java", line: 3, symbol: "BookingsBean" },
      hunks: [{ id: `dh${i}`, file: "cdi/BookingsBean.java", start: 3, role: "link", label: "BookingsBean" }],
    } as any);
    const out = renderAgent(model, { tokenBudget: 8000, intent: "how are bookings managed" });
    expect((out.match(/BookingsBean \(cdi\/BookingsBean\.java:3\)/g) ?? []).length).toBe(1);   // 4 seams → ONE region line
  });

  test("CROSS-STACK promotion — a JS node reached via a crossing from the Java spine is lifted into its own section (not off-path); a same-language crossing is NOT", () => {
    const model = {
      mode: "codebase", anchor: "n1", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "bookings", seams: [
        { id: "sBe", label: "BookingsService", tier: "spine", region: { shell: 0, direction: "down" }, primary: { file: "ejb/BookingsService.java", line: 5, symbol: "BookingsService" }, hunks: [{ id: "be", file: "ejb/BookingsService.java", start: 5, role: "core", label: "BookingsService" }] },
        { id: "sFe", label: "install", tier: "off", region: { shell: 3, direction: "down" }, primary: { file: "web/bookingService.js", line: 8, symbol: "install" }, hunks: [{ id: "fe", file: "web/bookingService.js", start: 8, role: "link", label: "install" }] },
        { id: "sJx", label: "sameStack", tier: "off", region: { shell: 2, direction: "down" }, primary: { file: "ejb/Other.java", line: 1, symbol: "sameStack" }, hunks: [{ id: "jx", file: "ejb/Other.java", start: 1, role: "link", label: "sameStack" }] },
      ] }],
      edges: [{ from: "be", to: "fe", kind: "db-read" }, { from: "be", to: "jx", kind: "db-read" }],   // both reached via a crossing
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how are bookings managed" });
    const cs = out.indexOf("## Cross-stack"), rg = out.indexOf("## Region");
    expect(cs).toBeGreaterThan(-1);
    expect(cs).toBeLessThan(rg);                                   // promoted section sits ABOVE the region
    const crossBlock = out.slice(cs, rg);
    expect(crossBlock).toContain("install (web/bookingService.js:8)");   // the JS frontend is promoted…
    expect(crossBlock).not.toContain("sameStack");                       // …but the same-language (Java) crossing is NOT
    expect(out.slice(rg)).toContain("sameStack");                        // it stays in the region
  });

  // TERMINAL-ANCHORED SPINE — the spine is the anchor→GROUNDED-BOUNDARY path (the deepest data-flow sink), NOT
  // the emit-time `tier==="spine"` band (the BFS-deepest node, which drifts to a routing terminus). Contract:
  // (a) a db-table boundary reached through a service IS the spine's outcome even when its tier is `off` (the
  // structure rescues a weakly-embedded boundary); (b) a HIGH-tier routing seam that is NOT on the anchor→sink
  // path is kept OFF the spine (no drift); (c) the spine reads anchor → service → db-table, in order.
  test("terminal-anchored spine: reaches the db-table sink (rescuing a low-tier boundary), not the drift-marked routing seam", () => {
    const model = {
      mode: "codebase", anchor: "ctrlh", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "persist a user", seams: [
        { id: "ctrl", label: "UserController", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "api/UserController.java", line: 1, symbol: "UserController" }, hunks: [{ id: "ctrlh", file: "api/UserController.java", start: 1, role: "core", label: "UserController" }] },
        { id: "svc", label: "UserService", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/UserService.java", line: 1, symbol: "UserService" }, hunks: [{ id: "svch", file: "svc/UserService.java", start: 1, role: "link", label: "UserService" }] },
        // the grounded terminal — a db-table boundary, deliberately tier `off` (embeds weakly) to prove the RESCUE
        { id: "ent", label: "UserEntity", tier: "off", relevance: 0.1, region: { shell: 2, direction: "down" }, primary: { file: "jpa/UserEntity.java", line: 1, symbol: "UserEntity" }, hunks: [{ id: "enth", file: "jpa/UserEntity.java", start: 1, role: "environment", label: "UserEntity", kind: "db-table" }] },
        // the DRIFT bait — a high-tier routing seam hanging off the controller, NOT on the anchor→db path
        { id: "route", label: "AdminRouter", tier: "spine", region: { shell: 1, direction: "up" }, primary: { file: "api/AdminRouter.java", line: 1, symbol: "AdminRouter" }, hunks: [{ id: "routeh", file: "api/AdminRouter.java", start: 1, role: "core", label: "AdminRouter" }] },
      ] }],
      edges: [{ from: "ctrlh", to: "svch", kind: "call" }, { from: "svch", to: "enth", kind: "db-write" }, { from: "ctrlh", to: "routeh", kind: "call" }],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a user persisted" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## Region") > -1 ? out.indexOf("## Region") : undefined);
    expect(out).toContain("## Spine");
    expect(spine).toContain("UserEntity");                              // the db-table sink IS the outcome (rescued from tier=off)
    expect(spine).toContain("UserService");                            // the intermediate mechanism is on the path
    expect(spine).not.toContain("AdminRouter");                        // the high-tier routing dead-end is NOT on the spine (no drift)
    expect(spine.indexOf("UserController")).toBeLessThan(spine.indexOf("UserService"));   // reads anchor → service → …
    expect(spine.indexOf("UserService")).toBeLessThan(spine.indexOf("UserEntity"));       // … → db-table sink, in order
    expect(out.slice(out.indexOf("## Region"))).toContain("AdminRouter");   // the drift-marked seam lands in the region instead
  });

  // CALL SITES — each spine hop prints the exact resolved edge (caller file:line ──kind──▶ callee), the
  // verify-by-glance line an agent trusts instead of re-grepping. edge.from is the caller, edge.line its call site.
  test("spine hops show the real call site (caller file:line ──kind──▶ callee)", () => {
    const model = {
      mode: "codebase", anchor: "ctrlh", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "persist a user", seams: [
        { id: "ctrl", label: "UserController", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "api/UserController.java", line: 12, symbol: "UserController" }, hunks: [{ id: "ctrlh", file: "api/UserController.java", start: 12, role: "core", label: "UserController" }] },
        { id: "svc", label: "persist", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/UserService.java", line: 8, symbol: "persist" }, hunks: [{ id: "svch", file: "svc/UserService.java", start: 8, role: "link", label: "persist" }] },
        { id: "utbl", label: "UserEntity", tier: "supporting", relevance: 0.9, region: { shell: 2, direction: "down" }, primary: { file: "jpa/UserEntity.java", line: 1, symbol: "UserEntity" }, hunks: [{ id: "utblh", file: "jpa/UserEntity.java", start: 1, role: "environment", label: "UserEntity", kind: "db-table" }] },
      ] }],
      edges: [{ from: "ctrlh", to: "svch", kind: "call", line: 41 }, { from: "svch", to: "utblh", kind: "db-write", line: 23 }],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a user persisted" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## Region") > -1 ? out.indexOf("## Region") : undefined);
    expect(spine).toContain("api/UserController.java:41 ──call──▶ persist");    // the caller call-site line, not a label
    expect(spine).toContain("svc/UserService.java:23 ──db-write──▶ UserEntity"); // the write site + the table it hits
  });

  // P2 — INTENT picks the primary among MULTIPLE downstream sinks; the rest render as "also reaches" (never hidden).
  test("intent picks the relevant sink (higher relevance) over a deeper one; the other sink is 'also reaches'", () => {
    const model = {
      mode: "codebase", anchor: "ctrlh", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "persist a user", seams: [
        { id: "ctrl", label: "UserController", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "api/UserController.java", line: 1, symbol: "UserController" }, hunks: [{ id: "ctrlh", file: "api/UserController.java", start: 1, role: "core", label: "UserController" }] },
        { id: "svc", label: "UserService", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/UserService.java", line: 1, symbol: "UserService" }, hunks: [{ id: "svch", file: "svc/UserService.java", start: 1, role: "link", label: "UserService" }] },
        // the ON-INTENT sink: high relevance, shallower
        { id: "utbl", label: "UserEntity", tier: "supporting", relevance: 0.9, region: { shell: 2, direction: "down" }, primary: { file: "jpa/UserEntity.java", line: 1, symbol: "UserEntity" }, hunks: [{ id: "utblh", file: "jpa/UserEntity.java", start: 1, role: "environment", label: "UserEntity", kind: "db-table" }] },
        // a DEEPER but off-intent sink (audit log) — deterministic depth would pick it; intent must NOT
        { id: "aw", label: "AuditWriter", tier: "off", region: { shell: 2, direction: "down" }, primary: { file: "svc/AuditWriter.java", line: 1, symbol: "AuditWriter" }, hunks: [{ id: "awh", file: "svc/AuditWriter.java", start: 1, role: "link", label: "AuditWriter" }] },
        { id: "atbl", label: "AuditEntity", tier: "off", relevance: 0.2, region: { shell: 3, direction: "down" }, primary: { file: "jpa/AuditEntity.java", line: 1, symbol: "AuditEntity" }, hunks: [{ id: "atblh", file: "jpa/AuditEntity.java", start: 1, role: "environment", label: "AuditEntity", kind: "db-table" }] },
      ] }],
      edges: [{ from: "ctrlh", to: "svch", kind: "call" }, { from: "svch", to: "utblh", kind: "db-write" }, { from: "svch", to: "awh", kind: "call" }, { from: "awh", to: "atblh", kind: "db-write" }],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a user persisted" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## Also reaches"));
    expect(spine).toContain("UserEntity");                    // the intent-relevant sink is the spine outcome…
    expect(spine).not.toContain("AuditEntity");               // …NOT the deeper, off-intent audit sink
    expect(out).toContain("## Also reaches");
    const alt = out.slice(out.indexOf("## Also reaches"), out.indexOf("## Region") > -1 ? out.indexOf("## Region") : undefined);
    expect(alt).toContain("AuditEntity");                     // the un-crowned sink is surfaced, not hidden
    expect(out.indexOf("## Also reaches")).toBeLessThan(out.indexOf("## Region"));   // placed right under the spine
    expect(out.slice(out.indexOf("## Region"))).not.toContain("AuditEntity");        // and NOT duplicated into the region
  });

  // DIRECT-WRITE PRIOR — the sink the ANCHOR writes directly (a produce edge from the anchor node) outranks a
  // higher-relevance but PERIPHERAL sink. On Keycloak the embedding rated UserVerifiableCredentialEntity (0.35)
  // over the plain UserEntity (0.16) that addUser's own em.persist writes — structure names the fact, embeddings
  // only order the rest. Here `audit` has HIGHER relevance but is written by a helper; the anchor writes `user`.
  test("direct-write prior: the sink the anchor writes directly wins over a higher-relevance peripheral sink", () => {
    const model = {
      mode: "codebase", anchor: "addh", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "persist a user", seams: [
        { id: "add", label: "addUser", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "jpa/UserProvider.java", line: 1, symbol: "addUser" }, hunks: [{ id: "addh", file: "jpa/UserProvider.java", start: 1, role: "core", label: "addUser" }] },
        // the anchor DIRECTLY writes UserEntity (lower relevance) …
        { id: "u", label: "UserEntity", tier: "off", relevance: 0.16, region: { shell: 1, direction: "down" }, primary: { file: "jpa/UserEntity.java", line: 1, symbol: "UserEntity" }, hunks: [{ id: "uh", file: "jpa/UserEntity.java", start: 1, role: "environment", label: "UserEntity", kind: "db-table" }] },
        // … while a HELPER writes AuditEntity (HIGHER relevance, but not the anchor's own write)
        { id: "aw", label: "audit", tier: "off", region: { shell: 1, direction: "down" }, primary: { file: "jpa/Audit.java", line: 1, symbol: "audit" }, hunks: [{ id: "awh", file: "jpa/Audit.java", start: 1, role: "link", label: "audit" }] },
        { id: "a", label: "AuditEntity", tier: "off", relevance: 0.42, region: { shell: 2, direction: "down" }, primary: { file: "jpa/AuditEntity.java", line: 1, symbol: "AuditEntity" }, hunks: [{ id: "ah", file: "jpa/AuditEntity.java", start: 1, role: "environment", label: "AuditEntity", kind: "db-table" }] },
      ] }],
      edges: [{ from: "addh", to: "uh", kind: "db-write", line: 134 }, { from: "addh", to: "awh", kind: "call" }, { from: "awh", to: "ah", kind: "db-write" }],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a user persisted" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## Also reaches") > -1 ? out.indexOf("## Also reaches") : out.indexOf("## Region"));
    expect(spine).toContain("UserEntity");        // the anchor's DIRECT write is the outcome…
    expect(spine).not.toContain("AuditEntity");   // …not the higher-relevance peripheral sink
    expect(out.slice(out.indexOf("## Also reaches"))).toContain("AuditEntity");   // which is surfaced as an alternate
  });

  // DELEGATING ANCHOR — the anchor writes NOTHING itself (a pure pass-through controller); its persistence is its
  // delegate's. Borrow the direct writes of the nodes it CALLS (one hop) so the delegate's write beats a DEEPER,
  // higher-relevance peripheral sink. `ctrl` delegates to `svc` (writes UserEntity); `audit` deeper writes the
  // higher-relevance AuditEntity — the one-hop delegate prior must still crown UserEntity.
  test("delegating anchor: the delegate's write (one call-hop) beats a deeper higher-relevance peripheral sink", () => {
    const model = {
      mode: "codebase", anchor: "ctrlh", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "persist a user", seams: [
        { id: "ctrl", label: "createUser", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "api/UserResource.java", line: 1, symbol: "createUser" }, hunks: [{ id: "ctrlh", file: "api/UserResource.java", start: 1, role: "core", label: "createUser" }] },
        { id: "svc", label: "addUser", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/UserService.java", line: 1, symbol: "addUser" }, hunks: [{ id: "svch", file: "svc/UserService.java", start: 1, role: "link", label: "addUser" }] },
        { id: "u", label: "UserEntity", tier: "off", relevance: 0.16, region: { shell: 2, direction: "down" }, primary: { file: "jpa/UserEntity.java", line: 1, symbol: "UserEntity" }, hunks: [{ id: "uh", file: "jpa/UserEntity.java", start: 1, role: "environment", label: "UserEntity", kind: "db-table" }] },
        { id: "aud", label: "audit", tier: "off", region: { shell: 2, direction: "down" }, primary: { file: "svc/Audit.java", line: 1, symbol: "audit" }, hunks: [{ id: "audh", file: "svc/Audit.java", start: 1, role: "link", label: "audit" }] },
        { id: "a", label: "AuditEntity", tier: "off", relevance: 0.44, region: { shell: 3, direction: "down" }, primary: { file: "jpa/AuditEntity.java", line: 1, symbol: "AuditEntity" }, hunks: [{ id: "ah", file: "jpa/AuditEntity.java", start: 1, role: "environment", label: "AuditEntity", kind: "db-table" }] },
      ] }],
      // ctrl writes nothing; it CALLS only svc (a pure delegate). svc writes UserEntity AND calls audit deeper —
      // so AuditEntity is written TWO hops from ctrl (via audit), NOT by a direct callee → not borrowed.
      edges: [{ from: "ctrlh", to: "svch", kind: "call", line: 20 }, { from: "svch", to: "uh", kind: "db-write", line: 55 }, { from: "svch", to: "audh", kind: "call" }, { from: "audh", to: "ah", kind: "db-write" }],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a user persisted" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## Also reaches") > -1 ? out.indexOf("## Also reaches") : out.indexOf("## Region"));
    expect(spine).toContain("UserEntity");        // svc (the anchor's sole delegate) writes it → borrowed as the direct sink
    expect(spine).not.toContain("AuditEntity");   // written by audit, TWO hops from ctrl (not a direct callee) → not borrowed; stays an alternate
    expect(out.slice(out.indexOf("## Also reaches"))).toContain("AuditEntity");
  });

  // FRONTIER-⟂ — no grounded sink, but the flow provably continues into an OPAQUE node the grow couldn't follow
  // (a runtime-DI multi-impl). The spine terminates THERE honestly — naming the break + candidate impls — instead
  // of falling to an inferred guess. An honest broken path that says WHERE it lost the thread > a smooth wrong one.
  test("frontier-⟂: a flow that dead-ends at an opaque DI hole names the break + candidates (not 'inferred')", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "how is a user loaded", seams: [
        { id: "a", label: "UserController", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "api/UserController.java", line: 1, symbol: "UserController" }, hunks: [{ id: "ah", file: "api/UserController.java", start: 1, role: "core", label: "UserController" }] },
        // the flow continues into session.users() — a runtime provider-factory the resolver can't follow (DI hole)
        { id: "u", label: "session.users", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/KeycloakSession.java", line: 1, symbol: "users" }, hunks: [{ id: "uh", file: "svc/KeycloakSession.java", start: 1, role: "link", label: "users" }] },
      ] }],
      edges: [{ from: "ah", to: "uh", kind: "call" }],   // NO boundary kind anywhere → no grounded sink
      blindspots: [{ node: "uh", mechanism: "interface-multiple-impls", evidence: "UserProvider has 6 implementations", candidates: [{ symbol: "JpaUserProvider" }, { symbol: "LdapUserProvider" }] }],
    };
    const out = renderAgent(model as any, { tokenBudget: 4000, intent: "how is a user loaded" });
    expect(out).toContain("## Spine (partial");                     // honest partial terminus, NOT "inferred"/"none"
    expect(out).not.toContain("inferred");
    expect(out).toContain("⟂ [interface-multiple-impls");           // the break is named at the DI hole
    expect(out).toContain("UserProvider has 6 implementations");
    expect(out).toContain("JpaUserProvider");                       // the candidate impls to deepen into
    expect(out.indexOf("UserController")).toBeLessThan(out.indexOf("⟂"));   // path leads UP TO the break, then stops
  });

  // P2 — the trust rule: under an intent, an anchor that reaches NO downstream boundary says so (noFlow), rather
  // than banding a fake spine. (No intent → no flow question → stay silent, no noFlow line — see the fallback test.)
  test("noFlow: an intent query that reaches no grounded boundary is told so, not given a fabricated spine", () => {
    const model = {
      mode: "codebase", anchor: "ch", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "compute a score", seams: [
        { id: "c", label: "Scorer", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "calc/Scorer.java", line: 1, symbol: "Scorer" }, hunks: [{ id: "ch", file: "calc/Scorer.java", start: 1, role: "core", label: "Scorer" }] },
        { id: "h", label: "helper", tier: "off", region: { shell: 1, direction: "down" }, primary: { file: "calc/Helper.java", line: 1, symbol: "helper" }, hunks: [{ id: "hh", file: "calc/Helper.java", start: 1, role: "link", label: "helper" }] },
      ] }],
      edges: [{ from: "ch", to: "hh", kind: "call" }],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 4000, intent: "how is the score computed" });
    expect(out).toContain("## Spine — none");                          // honest: no boundary reached
    expect(out).toContain("reaches no grounded boundary");
    expect(out).not.toMatch(/## Spine \(the primary path/);            // NOT a fabricated confident spine
  });

  test("no grounded boundary reachable → falls back to the tier band (spine preserved for non-coupling flows)", () => {
    // anchor maps to a seam, but NO edge reaches a boundary-kind seam → the terminal trace is empty → fall back to
    // the emit-time tier="spine" band (a same-language call chain keeps its structural spine; noFlow is a later pass).
    const out = renderAgent(makeModel(), { tokenBudget: 4000, intent: "how are bookings created" });
    expect(out).toContain("## Spine");                 // makeModel's anchor ("n1") doesn't map → fallback → tier spine shows
    expect(out).toContain("createBooking");
  });

  // CO-PRODUCERS ("## Also writes") — the OTHER writers of the table this flow writes (a table's alternate ENTRY
  // POINTS: a Stripe/Wix webhook writing `payments`, not just the routes that READ it). Gated (SEAM_COPRODUCERS);
  // focused on the spine's SINK table; excludes the anchor's own module (its in-flow writes are the main path).
  test("also-writes: surfaces external co-producers of the spine's sink table, excluding the anchor's own module", () => {
    const prev = process.env.SEAM_COPRODUCERS;
    process.env.SEAM_COPRODUCERS = "1";
    try {
      const model = {
        mode: "codebase", anchor: "ph", resolutionQuality: "FULL",
        clusters: [{ id: "g1", intent: "how are payments processed", seams: [
          { id: "proc", label: "processOne", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "app/pay/index.ts", line: 1, symbol: "processOne" }, hunks: [{ id: "ph", file: "app/pay/index.ts", start: 1, role: "core", label: "processOne" }] },
          { id: "pay", label: "payments", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "app/pay/index.ts", line: 40, symbol: "payments" }, hunks: [{ id: "payh", file: "app/pay/index.ts", start: 40, role: "environment", label: "payments", kind: "table" }] },
          // an EXTERNAL co-producer (a webhook, different module) that also writes `payments`
          { id: "hook", label: "payments", tier: "off", region: { shell: 2, direction: "down" }, primary: { file: "app/hooks/stripe.ts", line: 10, symbol: "payments" }, hunks: [{ id: "wh", file: "app/hooks/stripe.ts", start: 10, role: "environment", label: "payments", kind: "table" }] },
          // the anchor's OWN module also writes payments (a phase) — the main flow, NOT an alternate entry point
          { id: "phase", label: "payments", tier: "off", region: { shell: 1, direction: "down" }, primary: { file: "app/pay/phase.ts", line: 5, symbol: "payments" }, hunks: [{ id: "phh", file: "app/pay/phase.ts", start: 5, role: "environment", label: "payments", kind: "table" }] },
        ] }],
        edges: [{ from: "ph", to: "payh", kind: "db-write", line: 12 }, { from: "wh", to: "payh", kind: "db-write", line: 8 }, { from: "phh", to: "payh", kind: "db-write", line: 6 }],
        blindspots: [],
      };
      const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how are payments processed" });
      expect(out).toContain("## Also writes");
      const aw = out.slice(out.indexOf("## Also writes"), out.indexOf("## Region") > -1 ? out.indexOf("## Region") : undefined);
      expect(aw).toContain("app/hooks/stripe.ts");     // the external webhook co-producer is surfaced…
      expect(aw).not.toContain("app/pay/phase.ts");    // …but the anchor's OWN module's write is not (it's the main flow)
    } finally { if (prev === undefined) delete process.env.SEAM_COPRODUCERS; else process.env.SEAM_COPRODUCERS = prev; }
  });

  test("also-writes: silent when the flow writes no shared table with other producers", () => {
    // default-ON, but makeModel's flow writes no db-table (only a `call` edge) → no co-producers → no section.
    const out = renderAgent(makeModel(), { tokenBudget: 4000, intent: "how are bookings created" });
    expect(out).not.toContain("## Also writes");
  });

  test("blindspots are TRIAGED — sharpest (fewest candidates) lead first, top-5 shown + a rollup", () => {
    const model = makeModel({ offN: 0 });
    (model as any).blindspots = [
      { node: "sharp", mechanism: "di", evidence: "injected", candidates: [{ symbol: "OnlyImpl" }, { symbol: "Alt" }] },   // 2 candidates = sharpest
      ...Array.from({ length: 6 }, (_, i) => ({ node: `n${i}`, mechanism: "dispatch", evidence: "dyn", candidates: [{ symbol: `a${i}` }, { symbol: `b${i}` }, { symbol: `c${i}` }] })),   // 3 each
    ];
    const out = renderAgent(model, { tokenBudget: 4000, intent: "x" });
    expect(out).toContain("actionable (resolves to a known candidate set");   // the triage header
    expect(out.indexOf("sharp:")).toBeGreaterThan(-1);                        // the sharp lead is shown…
    expect(out.indexOf("sharp:")).toBeLessThan(out.indexOf("n0:"));           // …and ranks ABOVE the 3-candidate ones
    expect(out).toMatch(/\+2 more resolvable lead\(s\)/);                     // 7 leads, cap 5 → +2 rolled up
  });
});
