// QUALIFIED CROSS-FILE CALLEE — a method anchor that makes a STATIC / class-qualified call `Recv.method(...)`
// where `Recv` is a resolved in-repo class (Java `Helper.doWork(...)`). Before this pass the import/same-package
// pass resolved only the CLASS (a type-ref), so the invoked METHOD + its body silently vanished while the class
// read as "covered" (the Keycloak createUser gap: RepresentationToModel.createGroups et al missing, no blindspot).
// Two halves, both asserted here:
//   • RESOLVE — the method IS a unit in the receiver class → a `call` RESOLVED_PARTIAL edge to the concrete method
//     node (so the wave can then expand it and reach what IT does).
//   • ANNOUNCE — the receiver is a resolved in-repo class but the method is NOT found in it → an `unfollowed-call`
//     blindspot instead of the silent false-coverage.
// Hermetic Java fixture; guarded on tree-sitter (this pass is AST-derived).
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build_dependency_graph } from "../../src/codebase/scan/down/dependency_graph.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "qualified-callee");

// [anchorFile, anchorSymbol, receiverFileFragment] — Java carries object/name fields on the call node; TS/JS put
// the receiver under a `function` member_expression (imported class). Both must resolve identically.
const CASES: [string, string, string][] = [
  ["java/Service.java", "handle", "Helper.java"],
  ["service.ts", "handle", "helper.ts"],
];

describe("qualified cross-file callee resolution + honesty residue", () => {
  for (const [file, sym, recvFile] of CASES) {
    test(`${file}: a static call to a resolved in-repo class resolves the METHOD as a call edge`, async () => {
      if (!available()) return;
      const g = await build_dependency_graph(REPO, file, sym);
      const byId = new Map((g.nodes as any[]).map((n) => [n.id, n]));
      const callEdges = (g.edges as any[]).filter((e) => e.from === "n1" && e.kind === "call");
      const resolvedMethods = new Set(callEdges.map((e) => byId.get(e.to)?.symbol));
      // Helper.doWork and Helper.persist are real methods in the resolved Helper class → concrete call nodes
      expect(resolvedMethods.has("doWork")).toBe(true);
      expect(resolvedMethods.has("persist")).toBe(true);
      // grounded but not statically-proven dispatch → RESOLVED_PARTIAL (like interface-impl), never fabricated FULL
      const doWorkEdge = callEdges.find((e) => byId.get(e.to)?.symbol === "doWork");
      expect(doWorkEdge.provenance).toBe("RESOLVED_PARTIAL");
      // the resolved node points at the RECEIVER class's file, not the anchor file
      expect(byId.get(doWorkEdge.to)?.file).toContain(recvFile);
    });

    test(`${file}: a call to a resolved class whose method is absent emits an unfollowed-call blindspot`, async () => {
      if (!available()) return;
      const g = await build_dependency_graph(REPO, file, sym);
      const uc = (g.blindspots as any[]).filter((b) => b.mechanism === "unfollowed-call");
      expect(uc.length).toBe(1);
      expect(uc[0].evidence).toContain("Helper.missingMethod");
      // and it is NOT resolved as a call node (we didn't invent an edge for it)
      const byId = new Map((g.nodes as any[]).map((n) => [n.id, n]));
      const resolved = new Set((g.edges as any[]).filter((e) => e.from === "n1" && e.kind === "call").map((e) => byId.get(e.to)?.symbol));
      expect(resolved.has("missingMethod")).toBe(false);
    });
  }
});
