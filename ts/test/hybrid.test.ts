// Phase 3 gate for the HYBRID wiring path (the extension default: cluster=llm, roles=det,
// wiring=hybrid), made deterministic via the host bus serving BOTH passes (cluster + reconcile):
//  (1) RECONCILE PROMPT PARITY — build_reconcile_prompt byte-identical to Python.
//  (2) INJECT PARITY — fed the SAME canned cluster + reconcile replies, TS engine.classify
//      produces the recorded emit_seams_json (grounding, grounded_prune, apply_seam_groups).
//      NOTE: the .seams.json oracles are now TS REGRESSION SNAPSHOTS, not strict Python parity —
//      the hybrid wiring path has a TS-only same-file grounding rung (engine.hybridWiring) that
//      promotes same-file import→render couplings out of `suggested`; Python lacks it. Regenerate
//      with /tmp/regen_oracles.ts (or equivalent) after an intended hybridWiring change.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "../src/diff/parser.js";
import * as noise from "../src/diff/noise_filter.js";
import * as det from "../src/diff/classifier_det.js";
import { build_reconcile_prompt } from "../src/diff/classifier_llm.js";
import { RegexFactsProvider } from "../src/diff/facts.js";
import { classify } from "../src/diff/engine.js";
import { emit_seams_json } from "../src/diff/seams.js";
import { HostBus, set_host_bus } from "../src/core/llm.js";
import type { Hunk } from "../src/diff/parser.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const oracleDir = join(__dir, "oracle", "hybrid");
const samplePatch = join(__dir, "..", "..", "sample.patch");
// Only oracle-BACKED cases: ts/test/cases is shared with the eval harness corpus, which holds many
// patches that have no Python oracle (they're for scoring, not parity). Run parity on the ones that do.
const caseFiles = readdirSync(join(__dir, "cases")).filter((f) => f.endsWith(".patch")
  && existsSync(join(oracleDir, `${f.replace(/\.patch$/, "")}.reconcile.txt`)));
const cases: { name: string; path: string }[] = [
  ...caseFiles.map((f) => ({ name: f.replace(/\.patch$/, ""), path: join(__dir, "cases", f) })),
  { name: "sample", path: samplePatch },
];

function loadWork(path: string): Hunk[] {
  const hs = parse(readFileSync(path, "utf-8"));
  noise.classify(hs);
  return hs;
}

describe("reconcile prompt byte-parity vs Python", () => {
  for (const c of cases) {
    test(c.name, async () => {
      const work = loadWork(c.path).filter((h) => h.role !== "noise");
      const facts = await new RegexFactsProvider().facts(work);
      det.assign_roles(work, facts);          // reconcile prompt is built after the role pass
      const cores = new Map<string, Hunk>();
      for (const h of work) if (h.role === "core") cores.set(h.id, h);
      // hints = det candidate wires for targets (assign_wiring fills h.wires)
      det.assign_wiring(work, facts);
      const targets = work.filter((h) => h.role !== "core");
      const hints = new Map(targets.map((h) => [h.id, [...h.wires]]));
      const oracle = readFileSync(join(oracleDir, `${c.name}.reconcile.txt`), "utf-8");
      expect(build_reconcile_prompt(cores, targets, hints)).toBe(oracle);
    });
  }
});

describe("hybrid inject-llm parity vs Python", () => {
  for (const c of cases) {
    test(c.name, async () => {
      const cluster = readFileSync(join(oracleDir, `${c.name}.cluster.json`), "utf-8");
      const reconcile = readFileSync(join(oracleDir, `${c.name}.reconcile.json`), "utf-8");
      const oracle = JSON.parse(readFileSync(join(oracleDir, `${c.name}.seams.json`), "utf-8"));
      const hs = loadWork(c.path);
      set_host_bus(new HostBus({ cluster, reconcile }));
      try { await classify(hs, { cluster: "llm", roles: "det", wiring: "hybrid" }); }
      finally { set_host_bus(null); }
      expect(JSON.parse(JSON.stringify(await emit_seams_json(hs)))).toEqual(oracle);
    });
  }
});
