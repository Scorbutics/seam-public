// RESOLVED-BUT-UNFOLLOWED call leads are surfaced as DEEPEN HANDLES. A qualified cross-file static call
// (`Repo.persist(...)`) resolves the callee as a RESOLVED_PARTIAL `call` node (dependency_graph's qualified-callee
// pass), but the wave correctly does NOT auto-follow a PARTIAL lead (the "don't follow a PARTIAL" contract), so the
// callee's own body (and what IT reaches) stays unmapped. Before this fix that node folded silently into the anchor
// blob; now _phaseExpand parks it as a frontier decision point so the map ADVERTISES it (the Keycloak createUser →
// createCredentials → credential-store case: the write is one `--grow-from` away, and now the map says so).
//
// Hermetic tmp Java repo, deterministic floor, NO LLM; guards on tree-sitter. Other containments off so the parked
// leaf is the sole frontier signal.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

const repo = join(tmpdir(), "seam-partial-frontier-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  // Service.handle makes a QUALIFIED static call `Repo.persist(rep)` — Repo is a same-package in-repo class, persist
  // a multi-line method (a real body to deepen: it calls Store.write). The qualified-callee pass resolves persist as
  // a RESOLVED_PARTIAL `call` node; the wave won't auto-follow it → it must surface as a `decision` frontier point.
  w("app/Service.java", `package app;
public class Service {
    public void handle(String rep) {
        Repo.persist(rep);
    }
}
`);
  w("app/Repo.java", `package app;
public class Repo {
    public static void persist(String rep) {
        String norm = rep.trim();
        Store.write(norm);
        Store.flush();
    }
}
`);
  w("app/Store.java", `package app;
public class Store {
    public static void write(String v) { }
    public static void flush() { }
}
`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("resolved-but-unfollowed PARTIAL call leaf → frontier decision point", () => {
  test("the qualified callee is parked as a deepenable frontier decision point", async () => {
    if (!available()) return;
    const [data]: [any, any[]] = await grow_to_terminals(repo, "app/Service.java", "handle",
      { dataCoupling: false, upHop: 2, tierGrow: false, hubGate: false, ubiquity: false, hubCollapse: false, intent: "persist a record" });
    // persist resolved as a RESOLVED_PARTIAL call node (the qualified-callee pass) …
    const persistNode = (data.nodes as any[]).find((n) => n.symbol === "persist");
    expect(persistNode).toBeDefined();
    const callEdge = (data.edges as any[]).find((e) => e.to === persistNode.id && e.kind === "call");
    expect(callEdge?.provenance).toBe("RESOLVED_PARTIAL");
    // … the wave did NOT auto-follow it (no outgoing edges of its own) …
    expect((data.edges as any[]).some((e) => e.from === persistNode.id)).toBe(false);
    // … so it is SURFACED as a decision-point frontier (a deepen handle), not silently a terminal.
    const fr = ((data as any).frontier ?? []).find((f: any) => f.symbol === "persist");
    expect(fr).toBeDefined();
    expect(fr.cutBy).toBe("decision");
    expect(fr.reachedVia).toContain("handle");   // "called by … handle"
  });
});
