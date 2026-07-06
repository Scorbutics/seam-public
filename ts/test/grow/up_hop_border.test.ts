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
