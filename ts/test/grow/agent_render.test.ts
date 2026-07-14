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

  // HUB-TABLE COLLAPSE — a shared-key HUB table (`user`/`workflowStep`, touched by dozens of files) surfaces as one
  // region seam PER file, flooding the region (cal.com: `user`×24). Those crossings are already rolled up in the
  // shared-key Blindspot, so a label carried by ≥K DISTINCT region seams folds to ONE + a single pointer line.
  test("region HUB-TABLE collapse — a table shared by ≥K region seams folds to one line + a rollup", () => {
    const model = makeModel({ offN: 0 });
    for (let i = 0; i < 7; i++) model.clusters[0].seams.push({
      id: `hub${i}`, label: "user", tier: "supporting", relevance: 0.3, region: { shell: 2, direction: "down" },
      primary: { file: `svc/f${i}.ts`, line: 1, symbol: "user" },   // SAME hub label `user`, DISTINCT files (so dedup keeps them)
      hunks: [{ id: `hh${i}`, file: `svc/f${i}.ts`, start: 1, role: "link", label: "user" }],
    } as any);
    const out = renderAgent(model, { tokenBudget: 8000, intent: "how are users handled" });
    expect((out.match(/user \(svc\/f\d\.ts:1\)/g) ?? []).length).toBe(1);                    // 7 `user` hub seams → ONE visible line
    expect(out).toMatch(/\+6 more file\(s\) folded as shared-key hub crossings over:.*user/);   // …the other 6 rolled up, honestly, pointing to Blindspots
  });

  test("hub-table collapse opts out under SEAM_REGION_HUB_COLLAPSE=0 (all N lines return)", () => {
    const model = makeModel({ offN: 0 });
    for (let i = 0; i < 7; i++) model.clusters[0].seams.push({
      id: `hub${i}`, label: "acct", tier: "supporting", relevance: 0.3, region: { shell: 2, direction: "down" },
      primary: { file: `svc/g${i}.ts`, line: 1, symbol: "acct" }, hunks: [{ id: `gh${i}`, file: `svc/g${i}.ts`, start: 1, role: "link", label: "acct" }],
    } as any);
    process.env.SEAM_REGION_HUB_COLLAPSE = "0";
    const out = renderAgent(model, { tokenBudget: 20000, intent: "how are accounts handled" });
    delete process.env.SEAM_REGION_HUB_COLLAPSE;
    expect((out.match(/acct \(svc\/g\d\.ts:1\)/g) ?? []).length).toBe(7);   // opted out → the raw fan (deterministic escape hatch)
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
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(out).toContain("## Spine");
    expect(spine).toContain("UserEntity");                              // the db-table sink IS the outcome (rescued from tier=off)
    expect(spine).toContain("UserService");                            // the intermediate mechanism is on the path
    expect(spine).not.toContain("AdminRouter");                        // the high-tier routing dead-end is NOT on the spine (no drift)
    expect(spine.indexOf("UserController")).toBeLessThan(spine.indexOf("UserService"));   // reads anchor → service → …
    expect(spine.indexOf("UserService")).toBeLessThan(spine.indexOf("UserEntity"));       // … → db-table sink, in order
    expect(out.slice(out.indexOf("## Region"))).toContain("AdminRouter");   // the drift-marked seam lands in the region instead
  });

  // ANCHOR REACH is NODE-scoped, not seam-scoped: a big merged anchor seam otherwise reports a call into a
  // SIBLING member as "the anchor called by X" (private-app: processOne "called by signUp", an HTTP-invoke into a
  // sibling). Only real callers of the anchor NODE should show.
  test("anchor 'called by' is node-scoped: a call into a sibling in the merged anchor seam is not attributed to the anchor", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "how is it processed", seams: [
        // the anchor seam is a MERGED blob: processOne + a sibling `helper`, same seam
        { id: "aseam", label: "processOne", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "svc/index.ts", line: 1, symbol: "processOne" }, hunks: [
          { id: "ah", file: "svc/index.ts", start: 1, role: "core", label: "processOne" },
          { id: "sib", file: "svc/index.ts", start: 80, role: "link", label: "helper" },
        ] },
        { id: "tbl", label: "payments", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/index.ts", line: 40, symbol: "payments" }, hunks: [{ id: "th", file: "svc/index.ts", start: 40, role: "environment", label: "payments", kind: "table" }] },
        { id: "extS", label: "invoker", tier: "off", region: { shell: 1, direction: "up" }, primary: { file: "app/page.tsx", line: 1, symbol: "invoker" }, hunks: [{ id: "ext", file: "app/page.tsx", start: 1, role: "link", label: "invoker" }] },
        { id: "rcS", label: "processAll", tier: "off", region: { shell: 1, direction: "up" }, primary: { file: "svc/batch.ts", line: 1, symbol: "processAll" }, hunks: [{ id: "rc", file: "svc/batch.ts", start: 1, role: "link", label: "processAll" }] },
      ] }],
      edges: [{ from: "ah", to: "th", kind: "db-write", line: 40 }, { from: "ext", to: "sib", kind: "call" }, { from: "rc", to: "ah", kind: "call" }],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is it processed" });
    const step1 = out.slice(out.indexOf("## Spine"), out.indexOf("──db-write")); // the anchor line
    expect(step1).toContain("called by processAll");   // a real caller of the anchor NODE shows…
    expect(step1).not.toContain("invoker");             // …a call into a SIBLING (the merged-blob leak) does NOT
  });

  // A RESOLVED_PARTIAL `call` edge is a NAME-MATCH lead (unresolved receiver — "may not be your method"), not a
  // confirmed caller: on an over-loaded name (keycloak has 56 `createUser` methods) a flat "called by X" invents
  // false callers. The reach line must hedge PARTIAL callers ("possibly called by") and rank grounded (FULL) ones
  // first. This is the render-side twin of the resolver's don't-follow-a-PARTIAL contract.
  test("anchor reach: a name-match (PARTIAL) caller reads 'possibly called by'; a FULL caller 'called by' and ranks first", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "how is a user created", seams: [
        { id: "aseam", label: "createUser", tier: "spine", region: { shell: 0, direction: "down" }, primary: { file: "api/UsersResource.java", line: 131, symbol: "createUser" }, hunks: [{ id: "ah", file: "api/UsersResource.java", start: 131, role: "core", label: "createUser" }] },
        { id: "fS", label: "realCaller", tier: "off", region: { shell: 1, direction: "up" }, primary: { file: "api/Bootstrap.java", line: 1, symbol: "realCaller" }, hunks: [{ id: "fc", file: "api/Bootstrap.java", start: 1, role: "link", label: "realCaller" }] },
        { id: "nmS", label: "importUsers", tier: "off", region: { shell: 1, direction: "up" }, primary: { file: "api/Other.java", line: 1, symbol: "importUsers" }, hunks: [{ id: "nm", file: "api/Other.java", start: 1, role: "link", label: "importUsers" }] },
      ] }],
      edges: [
        { from: "fc", to: "ah", kind: "call", provenance: "RESOLVED_FULL" },     // a grounded caller
        { from: "nm", to: "ah", kind: "call", provenance: "RESOLVED_PARTIAL" },  // a bare-name collision lead
      ],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a user created" });
    const step1 = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(step1).toContain("called by realCaller");            // FULL → confident
    expect(step1).toContain("possibly called by importUsers");  // PARTIAL name-match → hedged
    expect(step1.indexOf("called by realCaller")).toBeLessThan(step1.indexOf("possibly called by importUsers")); // FULL first
  });

  // BLOB-SIBLING GUARD — the anchor node is often assembled into a MERGED seam with unrelated siblings (private-app: `signUp`
  // merged with a `notifyPayment` that writes the `payments` hub). Expanding the whole seam let a SIBLING's boundary
  // become the anchor's spine outcome — the payments/workflowReminder hijack. The spine must expand the anchor seam
  // ONLY via edges incident to the anchor NODE, so its OWN flow's sink (members) is crowned even when a sibling's sink
  // (payments) scores HIGHER on intent relevance.
  test("the anchor's own-flow sink is crowned, not a merged-blob sibling's higher-relevance boundary", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL", lead: "backward",
      clusters: [{ id: "g1", intent: "how does signup persist a user", seams: [
        { id: "aseam", label: "signUp", tier: "spine", region: { shell: 0, direction: "down" }, primary: { file: "svc/auth.ts", line: 1, symbol: "signUp" }, hunks: [
          { id: "ah", file: "svc/auth.ts", start: 1, role: "core", label: "signUp", kind: "function" },
          { id: "sib", file: "svc/auth.ts", start: 50, role: "link", label: "notifyPayment", kind: "function" },   // a blob sibling in the same seam
        ] },
        { id: "svcS", label: "completeOnboarding", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/onboarding.ts", line: 1, symbol: "completeOnboarding" }, hunks: [{ id: "svc", file: "svc/onboarding.ts", start: 1, role: "link", label: "completeOnboarding", kind: "function" }] },
        { id: "svc2S", label: "createMember", tier: "supporting", region: { shell: 2, direction: "down" }, primary: { file: "svc/members.ts", line: 1, symbol: "createMember" }, hunks: [{ id: "svc2", file: "svc/members.ts", start: 1, role: "link", label: "createMember", kind: "function" }] },
        { id: "memS", label: "members", tier: "supporting", relevance: 0.1, region: { shell: 3, direction: "down" }, primary: { file: "db/members.ts", line: 1, symbol: "members" }, hunks: [{ id: "mem", file: "db/members.ts", start: 1, role: "environment", label: "members", kind: "db-table" }] },
        { id: "payS", label: "payments", tier: "supporting", relevance: 0.9, region: { shell: 1, direction: "down" }, primary: { file: "db/payments.ts", line: 1, symbol: "payments" }, hunks: [{ id: "pay", file: "db/payments.ts", start: 1, role: "environment", label: "payments", kind: "db-table" }] },
      ] }],
      edges: [
        { from: "ah", to: "svc", kind: "call" },         // the ANCHOR's own flow: signUp → completeOnboarding …
        { from: "svc", to: "svc2", kind: "call" },       // … → createMember (so `members` is 3 hops, NOT a 1-hop directSink)
        { from: "svc2", to: "mem", kind: "db-write" },   // … → writes `members` (the true subject, LOW relevance)
        { from: "sib", to: "pay", kind: "db-write" },    // a BLOB SIBLING writes `payments` (HIGH relevance) — must NOT be the outcome
      ],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how does signup persist a user" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(spine).toContain("members");        // the anchor's OWN-flow sink is crowned…
    expect(spine).not.toContain("payments");   // …the blob sibling's boundary is NOT, despite higher relevance
  });

  // DIRECT-WRITE CANDIDATE — a table the ANCHOR writes is the outcome even when the BFS can't reach it. In a
  // `forward` (consumers-lead) footprint the anchor's own db-write edge (anchor→table) is traversed as table→anchor,
  // so the table is unreachable DOWNSTREAM and the distance BFS misses it — yet the anchor demonstrably writes it. An
  // anchor that persists its subject IN ITS OWN FILE (cal.com createTeamsHandler → `team`) must still get a GROUNDED
  // spine crowning that write, not fall to the off-subject tier band.
  test("a grounded anchor write is crowned even when the fwd-BFS reversed its edge (no dist)", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL", lead: "forward",
      clusters: [{ id: "g1", intent: "how is a team created", seams: [
        { id: "aseam", label: "createTeamsHandler", tier: "spine", region: { shell: 0, direction: "down" }, primary: { file: "svc/teams.ts", line: 1, symbol: "createTeamsHandler" }, hunks: [{ id: "ah", file: "svc/teams.ts", start: 1, role: "core", label: "createTeamsHandler", kind: "function" }] },
        { id: "tblS", label: "team", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "db/team.ts", line: 1, symbol: "team" }, hunks: [{ id: "tbl", file: "db/team.ts", start: 1, role: "environment", label: "team", kind: "db-table" }] },
      ] }],
      // the anchor WRITES team; in fwd mode the BFS reverses this to team→anchor, so team is not in `dist`.
      edges: [{ from: "ah", to: "tbl", kind: "db-write" }],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a team created" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(spine).toContain("team");                                   // the anchor's own write is crowned…
    expect(out).not.toContain("## Spine (inferred");                   // …and the spine is GROUNDED, not inferred
  });

  // WRITE-OVER-READ HOP — a hop INTO a data-store must show the WRITE (the outcome), not a co-located read on the
  // same table. private-app `weekly_tasks` is reached by both a `.upsert` (db-write) and an idempotency `.select` (db-read);
  // both tie on _WAVE_RANK, so the read arbitrarily won and "…and stored" showed a `db-read` at the select line.
  test("a spine hop into a store shows the db-write, not a co-located db-read on the same table", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "how are weekly tasks stored", seams: [
        { id: "aseam", label: "saveTasks", tier: "spine", region: { shell: 0, direction: "down" }, primary: { file: "repo.ts", line: 1, symbol: "saveTasks" }, hunks: [{ id: "ah", file: "repo.ts", start: 1, role: "core", label: "saveTasks", kind: "function" }] },
        { id: "tblS", label: "weekly_tasks", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "repo.ts", line: 411, symbol: "weekly_tasks" }, hunks: [{ id: "tbl", file: "repo.ts", start: 411, role: "environment", label: "weekly_tasks", kind: "db-table" }] },
      ] }],
      edges: [
        { from: "ah", to: "tbl", kind: "db-read", line: 417 },    // an idempotency .select — listed FIRST (would win the tie)
        { from: "ah", to: "tbl", kind: "db-write", line: 411 },   // the actual .upsert — the outcome
      ],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how are weekly tasks stored" });
    const hop = out.slice(out.indexOf("## Spine")).split("\n").find((l) => l.includes("──") && l.includes("weekly_tasks")) ?? "";
    expect(hop).toContain("──db-write──▶ weekly_tasks");   // the WRITE is shown…
    expect(hop).not.toContain("db-read");                  // …not the co-located read
    expect(hop).toContain(":411");                         // …at the write line, not the select line (:417)
  });

  // DI-BINDING DELEGATE — a REST handler that persists THROUGH a DI binding (an `interface-impl` edge to the bound
  // impl, e.g. the session.groups()→JpaRealmProvider provider-hop) has no own write, so its effective write is the
  // impl's. The directSink borrow must follow the binding, else the grounded persist (UserEntity/GroupEntity) is
  // reached but never crowned and the spine stays "inferred → HTTP consumers".
  test("a table written by a DI-bound impl is crowned as the handler's persist (interface-impl delegate borrow)", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL", lead: "forward",   // fwd reverses the BFS → only the borrow can reach the sink
      clusters: [{ id: "g1", intent: "how is a group created and persisted", seams: [
        { id: "aseam", label: "addGroup", tier: "spine", region: { shell: 0, direction: "down" }, primary: { file: "api/GroupsResource.java", line: 1, symbol: "addGroup" }, hunks: [{ id: "ah", file: "api/GroupsResource.java", start: 1, role: "core", label: "addGroup", kind: "method" }] },
        { id: "implS", label: "JpaRealmProvider", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "jpa/JpaRealmProvider.java", line: 1, symbol: "JpaRealmProvider" }, hunks: [{ id: "impl", file: "jpa/JpaRealmProvider.java", start: 1, role: "link", label: "JpaRealmProvider", kind: "class" }] },
        { id: "tblS", label: "GroupEntity", tier: "supporting", region: { shell: 2, direction: "down" }, primary: { file: "jpa/GroupEntity.java", line: 1, symbol: "GroupEntity" }, hunks: [{ id: "tbl", file: "jpa/GroupEntity.java", start: 1, role: "environment", label: "GroupEntity", kind: "db-table" }] },
      ] }],
      edges: [
        { from: "ah", to: "impl", kind: "interface-impl" },   // the DI binding (provider-factory / @Inject)
        { from: "impl", to: "tbl", kind: "db-write" },        // the impl persists the entity
      ],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a group created and persisted" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(spine).toContain("GroupEntity");                 // the DI-crossed persist is crowned…
    expect(out).not.toContain("## Spine (inferred");        // …and the spine is GROUNDED, not inferred
  });

  // PROVIDER-WRITE crown — when a create flow persists through BOTH the DI PROVIDER (a `provider-impl` binding:
  // JpaRealmProvider, the impl of the interface `session.groups()` returns) AND a co-bound entity ADAPTER (an
  // `interface-impl` @Inject binding: GroupAdapter → role-mapping writes), the crown must land on the PROVIDER's
  // persist (the create) — even when the adapter's compound entity scores HIGHER on intent relevance (the embedding
  // rates `GroupRoleMappingEntity` over `GroupEntity`). The `provider-impl` edge is the structural tiebreak.
  test("the DI provider's persist is crowned over a co-bound entity adapter's higher-relevance write", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL", lead: "forward",
      clusters: [{ id: "g1", intent: "how is a group created and persisted", seams: [
        { id: "aseam", label: "addTopLevelGroup", tier: "spine", region: { shell: 0, direction: "down" }, primary: { file: "api/GroupsResource.java", line: 1, symbol: "addTopLevelGroup" }, hunks: [{ id: "ah", file: "api/GroupsResource.java", start: 1, role: "core", label: "addTopLevelGroup", kind: "method" }] },
        { id: "provS", label: "JpaRealmProvider", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "jpa/JpaRealmProvider.java", line: 1, symbol: "JpaRealmProvider" }, hunks: [{ id: "prov", file: "jpa/JpaRealmProvider.java", start: 1, role: "link", label: "JpaRealmProvider", kind: "class" }] },
        { id: "adapS", label: "GroupAdapter", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "jpa/GroupAdapter.java", line: 1, symbol: "GroupAdapter" }, hunks: [{ id: "adap", file: "jpa/GroupAdapter.java", start: 1, role: "link", label: "GroupAdapter", kind: "class" }] },
        { id: "primS", label: "GroupEntity", tier: "supporting", relevance: 0.10, region: { shell: 2, direction: "down" }, primary: { file: "jpa/GroupEntity.java", line: 1, symbol: "GroupEntity" }, hunks: [{ id: "prim", file: "jpa/GroupEntity.java", start: 1, role: "environment", label: "GroupEntity", kind: "db-table" }] },
        { id: "secS", label: "GroupRoleMappingEntity", tier: "supporting", relevance: 0.90, region: { shell: 2, direction: "down" }, primary: { file: "jpa/GroupRoleMappingEntity.java", line: 1, symbol: "GroupRoleMappingEntity" }, hunks: [{ id: "sec", file: "jpa/GroupRoleMappingEntity.java", start: 1, role: "environment", label: "GroupRoleMappingEntity", kind: "db-table" }] },
      ] }],
      edges: [
        { from: "ah", to: "prov", kind: "provider-impl" },   // the DI provider-factory binding (the create path)
        { from: "prov", to: "prim", kind: "db-write" },       // …persists GroupEntity
        { from: "ah", to: "adap", kind: "interface-impl" },   // a co-bound entity ADAPTER (@Inject GroupModel)
        { from: "adap", to: "sec", kind: "db-write" },        // …persists GroupRoleMappingEntity (HIGHER relevance)
      ],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a group created and persisted" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(spine).toContain("GroupEntity");                  // the provider's persist is crowned…
    expect(spine).not.toContain("GroupRoleMappingEntity");   // …not the adapter's higher-relevance write
  });

  // TRUST GATE — coupling OVER-ATTRIBUTION must not crown a spine terminal. A GETTER whose node-range bled over a
  // sibling's writes gets credited (via shared-key coupling) with db-writes to MANY unrelated tables it never
  // persists (keycloak `isValid` → `getUsername`, credited with writing 3 user tables). The signature is a single
  // NON-provider writer with ≥K distinct store writes — a real persist is FOCUSED (one aggregate). Contract: a
  // focused single-table delegate write IS crowned; the many-table bleed is REJECTED (demoted, never the crown) —
  // so the same store is right for one intent and wrong for another, exactly as intent-blind coupling demands.
  test("a getter credited (over-attribution) with writing MANY tables is NOT crowned; a focused delegate write is", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL", lead: "forward",
      clusters: [{ id: "g1", intent: "how are credentials validated", seams: [
        { id: "aseam", label: "isValid", tier: "spine", region: { shell: 0, direction: "down" }, primary: { file: "cred/PasswordCredentialProvider.java", line: 1, symbol: "isValid" }, hunks: [{ id: "ah", file: "cred/PasswordCredentialProvider.java", start: 1, role: "core", label: "isValid", kind: "method" }] },
        { id: "guS", label: "getUsername", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "jpa/UserAdapter.java", line: 1, symbol: "getUsername" }, hunks: [{ id: "gu", file: "jpa/UserAdapter.java", start: 1, role: "link", label: "getUsername", kind: "method" }] },
        { id: "svcS", label: "publishMetric", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "cred/Metrics.java", line: 1, symbol: "publishMetric" }, hunks: [{ id: "svc", file: "cred/Metrics.java", start: 1, role: "link", label: "publishMetric", kind: "method" }] },
        { id: "t1S", label: "UserAttributeEntity", tier: "supporting", relevance: 0.30, region: { shell: 2, direction: "down" }, primary: { file: "jpa/UserAttributeEntity.java", line: 1, symbol: "UserAttributeEntity" }, hunks: [{ id: "t1", file: "jpa/UserAttributeEntity.java", start: 1, role: "environment", label: "UserAttributeEntity", kind: "db-table" }] },
        { id: "t2S", label: "UserGroupMembershipEntity", tier: "supporting", relevance: 0.30, region: { shell: 2, direction: "down" }, primary: { file: "jpa/UserGroupMembershipEntity.java", line: 1, symbol: "UserGroupMembershipEntity" }, hunks: [{ id: "t2", file: "jpa/UserGroupMembershipEntity.java", start: 1, role: "environment", label: "UserGroupMembershipEntity", kind: "db-table" }] },
        { id: "t3S", label: "UserRoleMappingEntity", tier: "supporting", relevance: 0.90, region: { shell: 2, direction: "down" }, primary: { file: "jpa/UserRoleMappingEntity.java", line: 1, symbol: "UserRoleMappingEntity" }, hunks: [{ id: "t3", file: "jpa/UserRoleMappingEntity.java", start: 1, role: "environment", label: "UserRoleMappingEntity", kind: "db-table" }] },
        { id: "auS", label: "AuditEntity", tier: "supporting", relevance: 0.20, region: { shell: 2, direction: "down" }, primary: { file: "jpa/AuditEntity.java", line: 1, symbol: "AuditEntity" }, hunks: [{ id: "au", file: "jpa/AuditEntity.java", start: 1, role: "environment", label: "AuditEntity", kind: "db-table" }] },
      ] }],
      edges: [
        { from: "ah", to: "gu", kind: "call" }, { from: "ah", to: "svc", kind: "call" },
        { from: "gu", to: "t1", kind: "db-write" }, { from: "gu", to: "t2", kind: "db-write" }, { from: "gu", to: "t3", kind: "db-write" },  // the class-wide BLEED (3 tables, one getter)
        { from: "svc", to: "au", kind: "db-write" },   // a FOCUSED delegate write (one table)
      ],
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how are credentials validated" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(spine).toContain("AuditEntity");                     // the FOCUSED single-table delegate write is crowned…
    expect(spine).not.toContain("UserRoleMappingEntity");       // …not the highest-relevance over-attributed bleed
    expect(spine).not.toContain("UserAttributeEntity");
  });

  // TIER-BAND DRIFT — with no grounded/frontier terminal the emit's `tier==="spine"` band is a RELEVANCE ranking,
  // not a flow: it drifts to embedding-adjacent seams NOT on the anchor's resolved path (private-app `signIn` → `signUp`, a
  // file-adjacent sibling it never calls). When the anchor seam RESOLVED, the inferred band keeps only seams
  // structurally reachable from it, dropping the drift. (SEAM_SPINE_TRUST_GATE=0 restores the raw band.)
  test("inferred spine drops a tier-spine seam that is NOT on the anchor's resolved flow (drift)", () => {
    const model = {
      mode: "codebase", anchor: "ah", resolutionQuality: "FULL", lead: "forward",
      clusters: [{ id: "g1", intent: "how does a user sign in", seams: [
        { id: "aseam", label: "signIn", tier: "spine", region: { shell: 0, direction: "down" }, primary: { file: "auth/auth.ts", line: 1, symbol: "signIn" }, hunks: [{ id: "ah", file: "auth/auth.ts", start: 1, role: "core", label: "signIn", kind: "function" }] },
        { id: "suSeam", label: "signUp", tier: "spine", region: { shell: 3, direction: "down" }, primary: { file: "auth/auth.ts", line: 90, symbol: "signUp" }, hunks: [{ id: "su", file: "auth/auth.ts", start: 90, role: "core", label: "signUp", kind: "function" }] },   // a file-adjacent sibling, NOT reached from signIn
      ] }],
      edges: [],   // no grounded boundary, and no edge signIn→signUp → signUp is off the anchor's resolved flow
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how does a user sign in" });
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(spine).toContain("signIn");         // the resolved anchor stays
    expect(spine).not.toContain("signUp");     // the unreachable drift sibling is dropped
    // without the gate the raw relevance band restores the drift (proving it's the reach filter doing the work)
    process.env.SEAM_SPINE_TRUST_GATE = "0";
    const raw = renderAgent(model as any, { tokenBudget: 8000, intent: "how does a user sign in" });
    delete process.env.SEAM_SPINE_TRUST_GATE;
    expect(raw.slice(raw.indexOf("## Spine"), raw.indexOf("## ", raw.indexOf("## Spine") + 5))).toContain("signUp");
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
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
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
    // pin subject-continuity OFF: this asserts the base intent-pick / also-reaches contract, and `AuditEntity` is
    // deliberately off-subject (subject-dim, now default-on, would legitimately drop it — tested separately).
    const _sd = process.env.SEAM_SUBJECT_DIM; process.env.SEAM_SUBJECT_DIM = "0";
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a user persisted" });
    if (_sd === undefined) delete process.env.SEAM_SUBJECT_DIM; else process.env.SEAM_SUBJECT_DIM = _sd;
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
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
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(spine).toContain("UserEntity");        // the anchor's DIRECT write is the outcome…
    expect(spine).not.toContain("AuditEntity");   // …not the higher-relevance peripheral sink
    expect(out.slice(out.indexOf("## Also reaches"))).toContain("AuditEntity");   // which is surfaced as an alternate
  });

  // DEEP-CLOSURE ADMISSION — an orchestrator whose OWN write is bookkeeping (private-app runPhaseEnrich → `payments`
  // state), while the real DOMAIN culmination is written 2+ call-hops deep (runPhaseEnrich → provisionOrUpdateMember
  // → findMemberId → `members` tier). The old one-hop delegate scoping never ADMITTED the deep write, so it fell
  // into the blindspots and the reader never saw the tier update. The call closure now admits it as an ALTERNATE
  // (Also reaches) — but the anchor's own write still WINS the crown (deepen ADMISSION, preserve PRECEDENCE).
  test("deep-closure sink: a 2-hop domain write surfaces as an alternate while the anchor's own write stays crowned", () => {
    const model = {
      mode: "codebase", anchor: "orch", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "how is the member tier updated", seams: [
        { id: "o", label: "runPhaseEnrich", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "fn/phase-enrich.ts", line: 1, symbol: "runPhaseEnrich" }, hunks: [{ id: "orch", file: "fn/phase-enrich.ts", start: 1, role: "core", label: "runPhaseEnrich" }] },
        // the anchor's OWN write — bookkeeping state, the crown
        { id: "p", label: "payments", tier: "off", relevance: 0.30, region: { shell: 1, direction: "down" }, primary: { file: "fn/phase-enrich.ts", line: 2, symbol: "payments" }, hunks: [{ id: "ph", file: "fn/phase-enrich.ts", start: 2, role: "environment", label: "payments", kind: "db-table" }] },
        // two intermediate call hops → the deep domain writer
        { id: "m", label: "provisionOrUpdateMember", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "fn/provisioning.ts", line: 1, symbol: "provisionOrUpdateMember" }, hunks: [{ id: "mid", file: "fn/provisioning.ts", start: 1, role: "link", label: "provisionOrUpdateMember" }] },
        { id: "f", label: "findMemberId", tier: "supporting", region: { shell: 2, direction: "down" }, primary: { file: "fn/provisioning.ts", line: 9, symbol: "findMemberId" }, hunks: [{ id: "deep", file: "fn/provisioning.ts", start: 9, role: "link", label: "findMemberId" }] },
        // the DEEP domain write (2 call-hops from the anchor) — the real tier culmination, LOWER relevance than payments
        { id: "mem", label: "members", tier: "off", relevance: 0.25, region: { shell: 3, direction: "down" }, primary: { file: "fn/members.ts", line: 1, symbol: "members" }, hunks: [{ id: "memh", file: "fn/members.ts", start: 1, role: "environment", label: "members", kind: "db-table" }] },
      ] }],
      edges: [{ from: "orch", to: "ph", kind: "db-write", line: 88 }, { from: "orch", to: "mid", kind: "call", line: 82 },
        { from: "mid", to: "deep", kind: "call", line: 15 }, { from: "deep", to: "memh", kind: "db-write", line: 20 }],
      blindspots: [],
    };
    const _sd = process.env.SEAM_SUBJECT_DIM; process.env.SEAM_SUBJECT_DIM = "0";   // pin subject-dim off (both tables on-flow)
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is the member tier updated" });
    if (_sd === undefined) delete process.env.SEAM_SUBJECT_DIM; else process.env.SEAM_SUBJECT_DIM = _sd;
    const alsoIdx = out.indexOf("## Also reaches");
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
    expect(spine).toContain("payments");            // the anchor's OWN write stays crowned (precedence preserved)
    expect(alsoIdx).toBeGreaterThan(-1);
    expect(out.slice(alsoIdx)).toContain("members");   // the 2-hop deep culmination is ADMITTED as an alternate (not lost)
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
    // pin subject-continuity OFF (default-on) — this asserts the base delegate-prior contract; AuditEntity is
    // off-subject and would be legitimately dropped by subject-dim (tested separately).
    const _sd = process.env.SEAM_SUBJECT_DIM; process.env.SEAM_SUBJECT_DIM = "0";
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a user persisted" });
    if (_sd === undefined) delete process.env.SEAM_SUBJECT_DIM; else process.env.SEAM_SUBJECT_DIM = _sd;
    const spine = out.slice(out.indexOf("## Spine"), out.indexOf("## ", out.indexOf("## Spine") + 5));
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

  // MECHANISM (default-ON) — a direct-writer orchestrator's spine collapses to anchor→sink and buries the
  // mechanism; surface the anchor's downstream call fan, flow-ordered by call-site line, types excluded.
  test("mechanism: the anchor's sequential delegations, in call order, types dropped", () => {
    const prev = process.env.SEAM_PIPELINE; process.env.SEAM_PIPELINE = "1";
    try {
      const model = {
        mode: "codebase", anchor: "ah", resolutionQuality: "FULL",
        clusters: [{ id: "g1", intent: "how is it processed", seams: [
          { id: "a", label: "processOne", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "svc/orch.ts", line: 1, symbol: "processOne" }, hunks: [{ id: "ah", file: "svc/orch.ts", start: 1, role: "core", label: "processOne" }] },
          { id: "ph", label: "phases", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/phases.ts", line: 1, symbol: "phases" }, hunks: [
            { id: "p1", file: "svc/phase1.ts", start: 5, label: "runPhase1", kind: "function" },
            { id: "p2", file: "svc/phase2.ts", start: 8, label: "runPhase2", kind: "function" },
            { id: "p3", file: "svc/phase3.ts", start: 3, label: "runPhase3", kind: "function" },
            { id: "ty", file: "svc/types.ts", start: 1, label: "MyType", kind: "interface" },
          ] },
        ] }],
        // out-of-order + a type-ref + a line-0 ref that must all be handled
        edges: [{ from: "ah", to: "p2", kind: "import", line: 154 }, { from: "ah", to: "p1", kind: "import", line: 140 }, { from: "ah", to: "p3", kind: "call", line: 200 }, { from: "ah", to: "ty", kind: "import", line: 120 }, { from: "ah", to: "nofile", kind: "import", line: 0 }],
        blindspots: [],
      };
      const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is it processed" });
      const pipe = out.slice(out.indexOf("## Mechanism"), out.indexOf("## Region") > -1 ? out.indexOf("## Region") : undefined);
      expect(out).toContain("## Mechanism");
      expect(pipe).not.toContain("MyType");   // a pure type-ref is not an execution step
      expect(pipe.indexOf("runPhase1")).toBeGreaterThan(-1);
      expect(pipe.indexOf("runPhase1")).toBeLessThan(pipe.indexOf("runPhase2"));   // flow order by call-site line…
      expect(pipe.indexOf("runPhase2")).toBeLessThan(pipe.indexOf("runPhase3"));   // …not edge-list order
      expect(pipe).toContain("called at orch.ts:140");   // the call site in the anchor
    } finally { if (prev === undefined) delete process.env.SEAM_PIPELINE; else process.env.SEAM_PIPELINE = prev; }
  });

  // MECHANISM default-on + sink annotation + TRANSITIVE reach — the anchor writes a bookkeeping table (crowned
  // spine), while the real work is a downstream CALL fan (cal booking: EventManager.create / handlePayment /
  // scheduleWorkflows). The Mechanism section surfaces those operations by DEFAULT (no env), annotates the sink each
  // reaches (` ──▶ payment`), and reaches a 2-hop-deep step (persistRem) a one-hop scan would miss.
  test("mechanism (default-on): downstream call fan with per-step sinks, transitive, spine-path excluded", () => {
    const model = {
      mode: "codebase", anchor: "h", resolutionQuality: "FULL",
      clusters: [{ id: "g1", intent: "how is a booking created and its side effects run", seams: [
        { id: "hs", label: "handler", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "svc/handler.ts", line: 1, symbol: "handler" }, hunks: [{ id: "h", file: "svc/handler.ts", start: 1, role: "core", label: "handler" }] },
        { id: "ss", label: "state", tier: "off", relevance: 0.4, region: { shell: 1, direction: "down" }, primary: { file: "svc/handler.ts", line: 88, symbol: "state" }, hunks: [{ id: "st", file: "svc/handler.ts", start: 88, role: "environment", label: "state", kind: "db-table" }] },
        { id: "es", label: "eventCreate", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/events.ts", line: 3, symbol: "eventCreate" }, hunks: [{ id: "ev", file: "svc/events.ts", start: 3, role: "core", label: "eventCreate" }] },
        { id: "ps", label: "payCharge", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/pay.ts", line: 5, symbol: "payCharge" }, hunks: [{ id: "pc", file: "svc/pay.ts", start: 5, role: "core", label: "payCharge" }] },
        { id: "pay", label: "payment", tier: "off", region: { shell: 2, direction: "down" }, primary: { file: "db/pay.ts", line: 1, symbol: "payment" }, hunks: [{ id: "payh", file: "db/pay.ts", start: 1, role: "environment", label: "payment", kind: "db-table" }] },
        { id: "scs", label: "schedule", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/wf.ts", line: 9, symbol: "schedule" }, hunks: [{ id: "sc", file: "svc/wf.ts", start: 9, role: "core", label: "schedule" }] },
        { id: "prs", label: "persistRem", tier: "supporting", region: { shell: 2, direction: "down" }, primary: { file: "svc/wf.ts", line: 40, symbol: "persistRem" }, hunks: [{ id: "pr", file: "svc/wf.ts", start: 40, role: "link", label: "persistRem" }] },
        { id: "rs", label: "reminder", tier: "off", region: { shell: 3, direction: "down" }, primary: { file: "db/rem.ts", line: 1, symbol: "reminder" }, hunks: [{ id: "remh", file: "db/rem.ts", start: 1, role: "environment", label: "reminder", kind: "db-table" }] },
      ] }],
      edges: [{ from: "h", to: "st", kind: "db-write", line: 88 },              // anchor's OWN bookkeeping write → crowned spine
        { from: "h", to: "ev", kind: "call", line: 10 },                        // a pure call op (no sink)
        { from: "h", to: "pc", kind: "call", line: 20 }, { from: "pc", to: "payh", kind: "db-write", line: 6 },   // op → payment
        { from: "h", to: "sc", kind: "call", line: 30 }, { from: "sc", to: "pr", kind: "call", line: 12 }, { from: "pr", to: "remh", kind: "db-write", line: 41 }],  // 2-hop → reminder
      blindspots: [],
    };
    const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how is a booking created and its side effects run" });
    const mi = out.indexOf("## Mechanism");
    expect(mi).toBeGreaterThan(-1);                                              // DEFAULT-ON, no env
    const mech = out.slice(mi, out.indexOf("## Region") > -1 ? out.indexOf("## Region") : undefined);
    expect(mech).toContain("eventCreate");                                       // the call fan the one-sink spine buried
    expect(mech).toMatch(/payCharge.*──▶ payment/);                              // a step annotated with the sink it persists
    expect(mech).toContain("persistRem");                                        // a 2-hop-deep step (transitive reach)
    expect(mech).not.toContain("1. state");                                      // a sink node is not itself a mechanism step
    expect(mech.indexOf("eventCreate")).toBeLessThan(mech.indexOf("persistRem")); // depth order: depth-1 ops before depth-2
  });

  // ALSO READ (gated SEAM_SUBJECT_READERS) — the symmetric of "## Also writes": an external file that READS the
  // subject table surfaces in "## Also read" (correctly labelled by the subject, not a co-touched hub); the
  // anchor's own module is excluded (its reads are the mechanism).
  test("also-read: external readers of the subject table surface, anchor's own module excluded (gated)", () => {
    const prev = process.env.SEAM_SUBJECT_READERS; process.env.SEAM_SUBJECT_READERS = "1";
    try {
      const model = {
        mode: "codebase", anchor: "ah", resolutionQuality: "FULL",
        clusters: [{ id: "g1", intent: "how are payments processed", seams: [
          { id: "a", label: "processOne", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "svc/pay/orch.ts", line: 1, symbol: "processOne" }, hunks: [{ id: "ah", file: "svc/pay/orch.ts", start: 1, role: "core", label: "processOne" }] },
          { id: "pay", label: "payments", tier: "supporting", region: { shell: 1, direction: "down" }, primary: { file: "svc/pay/orch.ts", line: 40, symbol: "payments" }, hunks: [{ id: "payh", file: "svc/pay/orch.ts", start: 40, role: "environment", label: "payments", kind: "table" }] },
          // an EXTERNAL reader of payments — surfaces in "## Also read"
          { id: "rdr", label: "listPayments", tier: "off", region: { shell: 2, direction: "down" }, primary: { file: "app/admin/list.ts", line: 12, symbol: "listPayments" }, hunks: [{ id: "rh", file: "app/admin/list.ts", start: 12, role: "link", label: "listPayments" }] },
          // the anchor's OWN module also reads payments (a phase select) — the mechanism, NOT a consumer
          { id: "ph", label: "phaseRead", tier: "off", region: { shell: 1, direction: "down" }, primary: { file: "svc/pay/phase.ts", line: 8, symbol: "phaseRead" }, hunks: [{ id: "phh", file: "svc/pay/phase.ts", start: 8, role: "link", label: "phaseRead" }] },
        ] }],
        edges: [{ from: "ah", to: "payh", kind: "db-write", line: 40 }, { from: "payh", to: "rh", kind: "db-read" }, { from: "payh", to: "phh", kind: "db-read" }],
        blindspots: [],
      };
      const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how are payments processed" });
      const read = out.slice(out.indexOf("## Also read"), out.indexOf("## Region") > -1 ? out.indexOf("## Region") : undefined);
      expect(out).toContain("## Also read");
      expect(read).toContain("app/admin/list.ts");     // external payments reader surfaced (the display side)
      expect(read).not.toContain("svc/pay/phase.ts");  // the anchor's own module read is the mechanism, not a consumer
    } finally { if (prev === undefined) delete process.env.SEAM_SUBJECT_READERS; else process.env.SEAM_SUBJECT_READERS = prev; }
  });

  // SUBJECT-CONTINUITY (gated SEAM_SUBJECT_DIM) — an off-subject sink (a table the flow's own module never
  // touches, reached only via a shared hub) is dropped from "## Also reaches"; an on-subject one is kept.
  test("subject-continuity: off-subject sink dropped from also-reaches, on-subject kept (gated)", () => {
    const prev = process.env.SEAM_SUBJECT_DIM; process.env.SEAM_SUBJECT_DIM = "1";
    try {
      const model = {
        mode: "codebase", anchor: "ah", resolutionQuality: "FULL",
        clusters: [{ id: "g1", intent: "how are payments processed", seams: [
          { id: "a", label: "processOne", tier: "supporting", region: { shell: 0, direction: "down" }, primary: { file: "svc/pay/orch.ts", line: 1, symbol: "processOne" }, hunks: [{ id: "ah", file: "svc/pay/orch.ts", start: 1, role: "core", label: "processOne" }] },
          { id: "pay", label: "payments", tier: "supporting", relevance: 0.9, region: { shell: 1, direction: "down" }, primary: { file: "svc/pay/orch.ts", line: 40, symbol: "payments" }, hunks: [{ id: "payh", file: "svc/pay/orch.ts", start: 40, role: "environment", label: "payments", kind: "table" }] },
          // the anchor's OWN module also touches `members` → members is a SUBJECT table (seed, needs no edge)
          { id: "memSubj", label: "members", tier: "off", region: { shell: 1, direction: "down" }, primary: { file: "svc/pay/phase.ts", line: 5, symbol: "members" }, hunks: [{ id: "msh", file: "svc/pay/phase.ts", start: 5, role: "environment", label: "members", kind: "table" }] },
          // an ON-subject alternate sink (members, from another module) — kept
          { id: "memS", label: "members", tier: "off", relevance: 0.2, region: { shell: 2, direction: "down" }, primary: { file: "svc/admin/x.ts", line: 1, symbol: "members" }, hunks: [{ id: "memh", file: "svc/admin/x.ts", start: 1, role: "environment", label: "members", kind: "table" }] },
          // an OFF-subject alternate sink (bug_reports, a table the pay module never touches) — dropped
          { id: "bugS", label: "bug_reports", tier: "off", relevance: 0.15, region: { shell: 2, direction: "down" }, primary: { file: "svc/support/y.ts", line: 1, symbol: "bug_reports" }, hunks: [{ id: "bugh", file: "svc/support/y.ts", start: 1, role: "environment", label: "bug_reports", kind: "table" }] },
        ] }],
        edges: [{ from: "ah", to: "payh", kind: "db-write", line: 40 }, { from: "ah", to: "memh", kind: "db-write" }, { from: "ah", to: "bugh", kind: "db-write" }],
        blindspots: [],
      };
      const out = renderAgent(model as any, { tokenBudget: 8000, intent: "how are payments processed" });
      const reach = out.slice(out.indexOf("## Also reaches"), out.indexOf("## Region") > -1 ? out.indexOf("## Region") : undefined);
      expect(reach).toContain("svc/admin/x.ts");     // members sink (on-subject) kept
      expect(reach).not.toContain("bug_reports");    // bug_reports sink (off-subject) dropped
    } finally { if (prev === undefined) delete process.env.SEAM_SUBJECT_DIM; else process.env.SEAM_SUBJECT_DIM = prev; }
  });

  test("pipeline: silent for a lone delegate (needs >=2 sequential steps) and off by default", () => {
    // default (gated off): never shows. Even gated on, a single delegation isn't a "pipeline".
    expect(renderAgent(makeModel(), { tokenBudget: 4000, intent: "x" })).not.toContain("## Pipeline");
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
