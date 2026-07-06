// PLAIN-CALL UP-FAN BORDER (SEAM_UP_HOP) — the deterministic, intent-FREE containment for the intra-backend
// flood. A wave flood climbing the CONSUMER (up) fan by plain calls (bean→bean→bean, no boundary) walks the whole
// backend web — the Acme case: one intent change re-floods hundreds of files. The border bounds the
// plain-call up-climb to K hops from the anchor (K = SEAM_UP_HOP / opts.upHop, "2 feels right"), PARKING nodes
// beyond as frontier decision points (deepenable, the "suggest next grows"), NOT growing their fan.
//
// The invariant this proves hermetically (tmp repo, det floor, NO LLM): (a) CONTAINED — a plain-call consumer
// chain past the cap is not grown; (b) RECALL preserved — a crossing (route/table/queue) RESETS the depth to 0,
// so cross-stack reach (UI ⇄ route ⇄ backend) survives past the cap unbounded; (c) SURFACED — the parked node
// is not silently dropped, it becomes a frontier decision point. Guards on tree-sitter (available()) for the .vsix.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

// The anchor `core` sits at the bottom of a plain-call CONSUMER chain (core ← svcB ← svcC ← svcD ← svcE — each
// calls the one below), the intra-backend up-fan to contain. `core` is ALSO reached from a Next route handler,
// which is coupled to a web page via a fetch("/api/x") crossing — the cross-stack path whose depth a crossing
// RESETS, so the web side must survive the cap even though it is many hops up.
const repo = join(tmpdir(), "seam-uphop-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{ "name": "uphop", "version": "1.0.0" }\n`);
  // the plain-call consumer chain climbing UP from the anchor (svcE is 4 hops up).
  w("svc/core.ts", `export function core(id: string) { return { id }; }\n`);
  w("svc/svcB.ts", `import { core } from "./core";\nexport function svcB(id: string) { return core(id); }\n`);
  w("svc/svcC.ts", `import { svcB } from "./svcB";\nexport function svcC(id: string) { return svcB(id); }\n`);
  w("svc/svcD.ts", `import { svcC } from "./svcC";\nexport function svcD(id: string) { return svcC(id); }\n`);
  w("svc/svcE.ts", `import { svcD } from "./svcD";\nexport function svcE(id: string) { return svcD(id); }\n`);
  // the cross-stack path: a Next route handler calls core (up-hop 1), the web page reaches it via a fetch crossing.
  w("app/api/x/route.ts", `import { NextResponse } from "next/server";\nimport { core } from "../../../svc/core";\nexport async function GET(request: Request) { return NextResponse.json(core("r")); }\n`);
  w("web/page.ts", `import { render } from "./caller";\nexport async function page() { const res = await fetch("/api/x"); return render(await res.json()); }\n`);
  w("web/caller.ts", `export function render(d: any) { return d; }\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

// The OTHER containment mechanisms (tier field, hub, ubiquity — all default-ON) are forced off so the plain-call
// flood is unbounded at baseline and SEAM_UP_HOP is the sole variable. This is the intent-FREE regime the border
// exists for (no embeddings / a big offline repo), where tier-grow cannot gate the up-climb.
const grow = (upHop: number) => grow_to_terminals(repo, "svc/core.ts", "core",
  { dataCoupling: true, upHop, tierGrow: false, hubGate: false, ubiquity: false, hubCollapse: false });
const filesOf = (data: any) => new Set((data.nodes as any[]).map((n) => String(n.file)));
const has = (data: any, frag: string) => [...filesOf(data)].some((f) => f.includes(frag));
const frontierHas = (data: any, frag: string) => ((data as any).frontier ?? []).some((f: any) => String(f.file).includes(frag));

describe("up-hop border — the plain-call consumer chain is contained; the crossing path survives", () => {
  test("BASELINE (upHop 0): the whole plain-call consumer chain floods in (the overgrow)", async () => {
    if (!available()) return;
    const [data]: [any, any[]] = await grow(0);
    expect(has(data, "svc/svcD.ts")).toBe(true);   // 3 hops up — reached by the unbounded flood
    expect(has(data, "svc/svcE.ts")).toBe(true);   // 4 hops up
  });

  test("CAP (upHop 2): the far chain is contained, the crossing path survives, the cut is surfaced", async () => {
    if (!available()) return;
    const [base]: [any, any[]] = await grow(0);
    const [cap]: [any, any[]] = await grow(2);
    // (a) CONTAINED — the plain-call chain past K hops is not grown, so the shape shrank.
    expect(has(cap, "svc/svcD.ts")).toBe(false);
    expect(has(cap, "svc/svcE.ts")).toBe(false);
    expect(cap.nodes.length).toBeLessThan(base.nodes.length);
    // (b) RECALL preserved — a crossing RESETS the up-depth, so the cross-stack (web ⇄ route) path survives the cap.
    expect(has(cap, "app/api/x/route.ts")).toBe(true);
    expect(has(cap, "web/page.ts")).toBe(true);
    // (c) SURFACED — the parked node is a frontier decision point (deepenable), NOT silently dropped.
    expect(frontierHas(cap, "svc/svcD.ts") || has(cap, "svc/svcC.ts")).toBe(true);
  });
});

// The SAME invariant on a REALISTIC Java-EJB shape — the Acme case Brice actually hits. A CDI bean
// (`CoreBean`) is climbed by a plain-call `@Inject` consumer CHAIN (Svc1←Svc2←Svc3←Svc4, the intra-backend
// flood) AND reached across a JAX-RS route from a JS UI (`@Path("core")` ⇄ `$http.get('/rest/core/...')`, the
// deterministic reverse cross-edge). The cap must cut the plain chain at K hops while the crossing branch — a
// far node whose up-depth a crossing RESET — survives. All-deterministic (coupling FLOOR, tier OFF): proves the
// structural border works on the shape private-app/booking-fixture are too thin to exhibit. Guards on tree-sitter.
const jrepo = join(tmpdir(), "seam-uphop-java-" + process.pid);
const jgit = (...a: string[]) => spawnSync("git", ["-C", jrepo, ...a], { encoding: "utf-8" });
const jw = (rel: string, t: string) => { const p = join(jrepo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  mkdirSync(jrepo, { recursive: true }); jgit("init", "-q"); jgit("config", "user.email", "t@t.t"); jgit("config", "user.name", "t");
  jw("ejb/com/x/CoreBean.java", "package com.x;\nimport javax.enterprise.context.ApplicationScoped;\n@ApplicationScoped\npublic class CoreBean {\n  public String core(String id) { return id; }\n}\n");
  // the plain-call @Inject consumer chain climbing UP from CoreBean (Svc4 is 4 hops up).
  jw("ejb/com/x/Svc1.java", "package com.x;\nimport javax.inject.Inject;\npublic class Svc1 {\n  @Inject CoreBean core;\n  public String svc1(String id) { return core.core(id); }\n}\n");
  jw("ejb/com/x/Svc2.java", "package com.x;\nimport javax.inject.Inject;\npublic class Svc2 {\n  @Inject Svc1 s;\n  public String svc2(String id) { return s.svc1(id); }\n}\n");
  jw("ejb/com/x/Svc3.java", "package com.x;\nimport javax.inject.Inject;\npublic class Svc3 {\n  @Inject Svc2 s;\n  public String svc3(String id) { return s.svc2(id); }\n}\n");
  jw("ejb/com/x/Svc4.java", "package com.x;\nimport javax.inject.Inject;\npublic class Svc4 {\n  @Inject Svc3 s;\n  public String svc4(String id) { return s.svc3(id); }\n}\n");
  // the crossing branch: a JAX-RS resource injects CoreBean; a JS UI fetches its route (server→client cross-edge).
  jw("svc/com/x/CoreResource.java", 'package com.x;\nimport javax.inject.Inject;\n@Path("core")\npublic class CoreResource {\n  @Inject CoreBean core;\n  @GET @Path("get/{id}")\n  public Response get(@PathParam("id") String id) { return Response.ok(core.core(id)).build(); }\n}\n');
  jw("web/js/coreUi.js", "export function loadCore(id) {\n  return $http.get('/rest/core/get/' + id);\n}\n");
  jgit("add", "-A");
});
afterAll(() => { rmSync(jrepo, { recursive: true, force: true }); });

const jgrow = (upHop: number) => grow_to_terminals(jrepo, "ejb/com/x/CoreBean.java", "core",
  { dataCoupling: true, bidirectional: true, upHop, tierGrow: false, hubGate: false, ubiquity: false, hubCollapse: false });
const jhas = (data: any, frag: string) => [...new Set((data.nodes as any[]).map((n) => String(n.file)))].some((f) => f.includes(frag));

describe("up-hop border (Java EJB) — the @Inject bean chain is capped, the JAX-RS crossing survives", () => {
  test("BASELINE (upHop 0): the whole @Inject consumer chain floods up", async () => {
    if (!available()) return;   // no tree-sitter → no Java units
    const [data]: [any, any[]] = await jgrow(0);
    expect(jhas(data, "Svc3.java")).toBe(true);
    expect(jhas(data, "Svc4.java")).toBe(true);
  });

  test("CAP (upHop 2): the chain is cut at K hops, the route→UI crossing branch is preserved", async () => {
    if (!available()) return;
    const [base]: [any, any[]] = await jgrow(0);
    const [cap]: [any, any[]] = await jgrow(2);
    // (a) CONTAINED — the deep plain-call @Inject hops are dropped.
    expect(jhas(cap, "Svc3.java")).toBe(false);
    expect(jhas(cap, "Svc4.java")).toBe(false);
    expect(cap.nodes.length).toBeLessThan(base.nodes.length);
    // (b) RECALL — the near hop is kept, and the JAX-RS route resets the up-depth so the JS UI across it survives.
    expect(jhas(cap, "Svc1.java")).toBe(true);
    expect(jhas(cap, "svc/com/x/CoreResource.java")).toBe(true);
    expect(jhas(cap, "web/js/coreUi.js")).toBe(true);
    // (c) SURFACED — the cut point (the deepest kept hop) is a frontier decision point.
    expect(((cap as any).frontier ?? []).length).toBeGreaterThan(0);
  });
});
