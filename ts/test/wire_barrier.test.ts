// Wiring lifecycle barrier (classifier_det): the det cluster pass reads h.wires, so it must run only
// AFTER the wiring pass has settled — in the hybrid path the wires are written by an async promise
// that overlaps the LLM cluster pass, so reading them early is a silent race the fuzzy harness won't
// catch. assign_wiring marks the work set PROVISIONAL; reconcile_wiring / finalize_wiring mark it
// SETTLED; assign_clusters throws while provisional. These tests pin that contract.
import { describe, expect, test } from "bun:test";
import * as det from "../src/diff/classifier_det.js";
import { mkFacts, type HunkFacts } from "../src/diff/facts.js";
import type { Hunk } from "../src/diff/parser.js";

const hunk = (id: string, file: string, role: string): Hunk =>
  ({ id, file_path: file, text: "", section_header: "", role,
     wires: [], resolved_wires: [], suggested_wires: [], spans: [], placements: [] }) as unknown as Hunk;

// A core + a link that name-couples to it — enough for assign_wiring to produce a candidate edge.
function fixture(): { work: Hunk[]; facts: Map<string, HunkFacts> } {
  const work = [hunk("h1", "src/foo.ts", "core"), hunk("h2", "src/bar.ts", "link")];
  const facts = new Map<string, HunkFacts>([
    ["h1", mkFacts({ defines: new Set(["doThing"]) })],
    ["h2", mkFacts({ references: new Set(["doThing"]) })],
  ]);
  return { work, facts };
}

describe("wiring lifecycle barrier", () => {
  test("assign_clusters THROWS when wiring is still provisional", () => {
    const { work, facts } = fixture();
    det.assign_wiring(work, facts);                 // marks provisional; no terminal pass yet
    expect(() => det.assign_clusters(work, facts)).toThrow(/provisional/i);
  });

  test("reconcile_wiring finalizes → assign_clusters is allowed", () => {
    const { work, facts } = fixture();
    det.assign_wiring(work, facts);
    det.reconcile_wiring(work, facts);              // det terminal: finalizes
    expect(() => det.assign_clusters(work, facts)).not.toThrow();
  });

  test("explicit finalize_wiring (the hybrid path's terminal) → assign_clusters is allowed", () => {
    const { work, facts } = fixture();
    det.assign_wiring(work, facts);
    det.finalize_wiring(work);                       // what engine.hybridWiring calls after writing h.wires
    expect(() => det.assign_clusters(work, facts)).not.toThrow();
  });

  test("barrier is keyed per work-set; finalizing one does not unlock another", () => {
    const a = fixture(), b = fixture();
    det.assign_wiring(a.work, a.facts);
    det.assign_wiring(b.work, b.facts);
    det.finalize_wiring(a.work);
    expect(() => det.assign_clusters(a.work, a.facts)).not.toThrow();
    expect(() => det.assign_clusters(b.work, b.facts)).toThrow(/provisional/i);
  });
});
