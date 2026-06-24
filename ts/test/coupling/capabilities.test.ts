// The coupling CAPABILITY CATALOGUE makes Tier-1 (built-in, deterministic, offline) vs Tier-2 (learned,
// warms on first review) HONEST instead of invisible — a user can see "Seam couples events/queues" without
// having warmed a repo. It is derived STRUCTURALLY from the registry (ARCHETYPES ∩ ADAPTERS), so adding a
// detection adapter for a learned archetype flips it to built-in with no list to keep in sync.
import { describe, expect, test } from "bun:test";
import { couplingCapabilities, kindOf } from "../../src/codebase/coupling/adapters/index.js";

describe("couplingCapabilities — tier is derived from whether a detection adapter owns the kind", () => {
  const caps = couplingCapabilities();
  const tierOf = (kind: string) => caps.find((c) => c.kind === kind)?.tier;

  test("every archetype kind resolves to a real boundary (not GENERIC) and appears in the catalogue", () => {
    for (const c of caps) {
      expect(kindOf(c.kind).nodeKind).toBe(c.nodeKind);   // catalogue node-kind matches the resolved archetype
      expect(c.nodeKind).not.toBe("resource");            // GENERIC's nodeKind — would mean the kind fell through
    }
  });

  test("db-table / http-route / data-file are BUILT-IN (a deterministic adapter detects them, offline)", () => {
    expect(tierOf("db-table")).toBe("built-in");
    expect(tierOf("http-route")).toBe("built-in");
    expect(tierOf("data-file")).toBe("built-in");
    // and they name their detectors (the registry, not a hardcoded label)
    expect(caps.find((c) => c.kind === "db-table")!.detectedBy.length).toBeGreaterThan(0);
  });

  test("event / binding / cache / queue are LEARNED — no detection adapter, warm on first review", () => {
    for (const kind of ["event", "binding", "cache", "queue"]) {
      expect(tierOf(kind)).toBe("learned");
      expect(caps.find((c) => c.kind === kind)!.detectedBy).toEqual([]);
    }
  });
});
