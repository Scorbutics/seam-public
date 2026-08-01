// THE TWO DYNAMIC BLIND SPOTS — flows static resolution cannot thread, reported honestly rather than dropped.
//
//   UP   `detect_dynamic_import_blindspots` — a consumer that loads the anchor by STRING PATH. The reference
//        resolver never sees it, so the anchor looks unused when it is not.
//   DOWN `detect_dynamic_dispatch_blindspots` — a node whose body dispatches OUT through a runtime choice, so
//        the flow continues into an impl (and its data sink) picked at runtime. Without this the node renders
//        as a dead-ending call step and the sink is silently lost.
//
// The scans are the core's (`seam_lang::atoms`), pinned there. Asserted HERE is the pass: the graph-side work
// that stayed in TypeScript — which candidates are EXCLUDED, and the shape of the blindspot record.
//
// Neither pass had any test, and neither appears anywhere in the CLI snapshot gate's 69 paths (checked, not
// assumed: no gate output contains `dynamic-import` or `dynamic-dispatch`). So this file is the only thing
// watching them.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { detect_dynamic_import_blindspots, detect_dynamic_dispatch_blindspots } from "../../src/codebase/detect.js";
import { Graph } from "../../src/core/graph_ir.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "detect-dyn-"));
  w("src/payment.ts", `export function charge() { return 1; }\n`);
  w("src/lazyLoader.ts", `export async function load() { const m = await import("./payment"); return m; }\n`);
  w("src/alsoLazy.ts", `export async function load2() { return import("../src/payment"); }\n`);
  // a consumer that ALREADY resolves statically — must not be re-reported as a blind spot
  w("src/staticUser.ts", `import { charge } from "./payment";\nexport const go = () => charge();\n`);
  // TWO IMPORTS WHERE ONLY THE SECOND IS THE REGISTRY — the per-ident memo's discriminator.
  //
  // `dynamic_dispatch_evidence` compiles its patterns PER IMPORTED IDENT and now memoises them (they were being
  // rebuilt once per node: ~100k compilations and 10.9s on the cal.com benchmark anchor). A memo keyed wrongly —
  // one entry shared by every ident — still passes every case where the registry is the FIRST import, because
  // the first ident's pattern is the one that gets cached. Verified: deliberately breaking the key that way left
  // this file at 6 pass / 0 fail. This fixture puts a non-registry import FIRST so the second lookup must return
  // its OWN pattern, and names the registry in the evidence so a right-answer-for-the-wrong-reason fails too.
  w("src/dispatchSecond.ts", `import { Formatter } from "./fmt";\nimport { HandlerRegistry } from "./registry";
export async function pick(key: string) {
  const h = HandlerRegistry[key];
  return await h();
}
`);
  w("src/dispatch.ts", `import { PaymentServiceMap } from "./generated";\nimport { ErrorCode } from "./codes";
export async function run(key: string) {
  const svc = PaymentServiceMap[key];
  const inst = await svc;
  return inst;
}
export function describeError(key: string) {
  return ErrorCode[key];
}
`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const anchorGraph = (file: string): any => {
  const g: any = new Graph();
  g.anchor = "n1";
  g.nodes.set("n1", { id: "n1", label: "charge", kind: "function", file, start: 0, end: 0 });
  return g;
};

describe("detect_dynamic_import_blindspots — the string-path load the resolver can't see", () => {
  test("a consumer that dynamic-imports the anchor becomes a SUGGESTED candidate", () => {
    const g = anchorGraph("src/payment.ts");
    detect_dynamic_import_blindspots(g, REPO);
    expect(g.blindspots.length).toBe(1);
    const bs = g.blindspots[0];
    expect(bs.mechanism).toBe("dynamic-import");
    expect(bs.node).toBe("n1");
    const dsts = bs.candidates.map((c: any) => c.dst).sort();
    expect(dsts).toEqual(["src/alsoLazy.ts:1", "src/lazyLoader.ts:1"]);
    // SUGGESTED, never RESOLVED — this is evidence a reader should check, not an edge the engine stands behind
    expect(bs.candidates.every((c: any) => c.provenance === "SUGGESTED")).toBe(true);
    expect(bs.evidence).toContain("2 place(s)");
  });

  test("a consumer already RESOLVED into the anchor is excluded", () => {
    const g = anchorGraph("src/payment.ts");
    // the static importer is a resolved consumer — reporting it as "can't see this" would contradict the
    // graph's own edge, so the pass must deduce from the resolved fact rather than re-guess
    g.nodes.set("n2", { id: "n2", label: "go", kind: "function", file: "src/staticUser.ts", start: 0, end: 1 });
    g.edges.push({ src: "n2", dst: "n1", kind: "calls", provenance: "RESOLVED_FULL", line: 1 });
    detect_dynamic_import_blindspots(g, REPO);
    const dsts = (g.blindspots[0]?.candidates ?? []).map((c: any) => c.dst);
    expect(dsts.some((d: string) => d.startsWith("src/staticUser.ts"))).toBe(false);
  });

  test("an anchor nothing dynamic-imports produces no blindspot at all", () => {
    const g = anchorGraph("src/staticUser.ts");
    detect_dynamic_import_blindspots(g, REPO);
    expect(g.blindspots.length).toBe(0);   // silence, not an empty record
  });
});

describe("detect_dynamic_dispatch_blindspots — the runtime impl choice", () => {
  const nodeGraph = (nodes: any[]): any => {
    const g: any = new Graph();
    g.anchor = nodes[0].id;
    for (const n of nodes) g.nodes.set(n.id, n);
    return g;
  };

  test("an ACTIVATED imported-registry subscript is reported, naming the registry", () => {
    const g = nodeGraph([{ id: "r1", label: "run", kind: "function", file: "src/dispatch.ts", start: 2, end: 6 }]);
    detect_dynamic_dispatch_blindspots(g, REPO);
    expect(g.blindspots.length).toBe(1);
    expect(g.blindspots[0].mechanism).toBe("dynamic-dispatch");
    expect(g.blindspots[0].evidence).toContain("PaymentServiceMap");
    expect(g.blindspots[0].evidence).toContain("chosen at runtime");
  });

  test("a scalar ENUM lookup of identical shape is NOT reported", () => {
    // `ErrorCode[key]` subscripts an imported map by a runtime key exactly like the registry above, but its
    // result is never activated as code — it resolves to a string, not an impl with a data sink. Reporting it
    // would make every enum lookup in a repo read as a lost flow.
    const g = nodeGraph([{ id: "e1", label: "describeError", kind: "function", file: "src/dispatch.ts", start: 7, end: 9 }]);
    detect_dynamic_dispatch_blindspots(g, REPO);
    expect(g.blindspots.length).toBe(0);
  });

  test("the registry is found when it is the SECOND import — the per-ident memo's discriminator", () => {
    // `src/dispatchSecond.ts` imports `Formatter` first and `HandlerRegistry` second, and only the second is a
    // registry. `dynamic_dispatch_evidence` memoises its compiled patterns per ident; a memo that shares ONE
    // entry across idents returns `Formatter`'s pattern for the `HandlerRegistry` lookup and finds nothing.
    // Verified: with the key deliberately broken that way, every OTHER case in this file still passed — the
    // registry is the first import in all of them, so the wrong cached pattern was accidentally the right one.
    const g: any = new Graph();
    g.anchor = "p1";
    g.nodes.set("p1", { id: "p1", label: "pick", kind: "function", file: "src/dispatchSecond.ts", start: 2, end: 5 });
    detect_dynamic_dispatch_blindspots(g, REPO);
    expect(g.blindspots.length).toBe(1);
    // Naming it matters: a pass that reported SOME registry would satisfy a bare length check while proving
    // the lookup had returned the wrong ident's pattern.
    expect(g.blindspots[0].evidence).toContain("HandlerRegistry");
  });

  test("a node with no body span is skipped rather than scanned as an empty body", () => {
    const g = nodeGraph([{ id: "z", label: "z", kind: "function", file: "src/dispatch.ts", start: 3, end: 3 }]);
    detect_dynamic_dispatch_blindspots(g, REPO);
    expect(g.blindspots.length).toBe(0);
  });
});
