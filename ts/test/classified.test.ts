// Differential oracle for the deterministic classifier: TS classify(parse(case)) must produce
// the SAME labeled hunks as the Python classifier_det.classify on all 6 real diffs. The Python
// dump (parser.hunks_to_json after noise + classifier_det) is captured in test/oracle/*.classified.json.
// This exercises lang + facts + symbol_edges + graph_ir + classifier_det together, end to end.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "../src/diff/parser.js";
import * as noise from "../src/diff/noise_filter.js";
import { classify } from "../src/diff/engine.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dir, "cases");
const oracleDir = join(__dir, "oracle");
// Only oracle-BACKED cases: ts/test/cases is shared with the eval harness corpus (many patches have
// no Python oracle — they are for scoring, not parity). Run parity on the ones with a classified oracle.
const cases = readdirSync(casesDir).filter((f) => f.endsWith(".patch")
  && existsSync(join(oracleDir, `${f.replace(/\.patch$/, "")}.classified.json`)))
  .map((f) => f.replace(/\.patch$/, "")).sort();

// Compare only the classifier-owned fields (the Python dump also carries the verbatim hunk
// `text`, which differs only by trailing-newline framing — not a classification fact).
const FIELDS = ["id", "role", "role_confidence", "rationale", "group", "intent",
  "seam", "seam_label", "wires", "resolved_wires", "suggested_wires", "spans", "placements"] as const;

function project(h: any) {
  const o: any = {};
  for (const f of FIELDS) o[f] = h[f];
  return o;
}

describe("classifier_det vs Python oracle (labeled hunks)", () => {
  for (const name of cases) {
    test(name, async () => {
      const oracle = JSON.parse(readFileSync(join(oracleDir, `${name}.classified.json`), "utf-8"));
      const hs = parse(readFileSync(join(casesDir, `${name}.patch`), "utf-8"));
      noise.classify(hs);
      await classify(hs, { cluster: "det", roles: "det", wiring: "det" });
      expect(hs.length).toBe(oracle.length);
      // Field-by-field over every hunk — surfaces the exact first divergence.
      hs.forEach((h, i) => {
        expect({ id: h.id, ...project(h) }).toEqual({ id: oracle[i].id, ...project(oracle[i]) });
      });
    });
  }
});
