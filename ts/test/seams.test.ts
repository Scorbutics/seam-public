// Differential oracle for seam assembly + text rendering: TS emit_seams_json and the ascii
// renderer must match Python on all 6 real diffs + sample.patch. Oracles in test/oracle/.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "../src/diff/parser.js";
import * as noise from "../src/diff/noise_filter.js";
import { classify } from "../src/diff/classifier_det.js";
import { emit_seams_json } from "../src/diff/seams.js";
import { render } from "../src/diff/report_text.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const oracleDir = join(__dir, "oracle");
const samplePatch = join(__dir, "..", "..", "sample.patch");

const caseFiles = readdirSync(join(__dir, "cases")).filter((f) => f.endsWith(".patch"));
const cases: { name: string; path: string }[] = [
  ...caseFiles.map((f) => ({ name: f.replace(/\.patch$/, ""), path: join(__dir, "cases", f) })),
  { name: "sample", path: samplePatch },
];

function classified(path: string) {
  const hs = parse(readFileSync(path, "utf-8"));
  noise.classify(hs);
  classify(hs);
  return hs;
}

describe("emit_seams_json vs Python oracle", () => {
  for (const c of cases) {
    test(c.name, () => {
      const oracle = JSON.parse(readFileSync(join(oracleDir, `${c.name}.seams.json`), "utf-8"));
      const got = JSON.parse(JSON.stringify(emit_seams_json(classified(c.path))));
      expect(got).toEqual(oracle);
    });
  }
});

describe("ascii renderer vs Python oracle", () => {
  for (const c of cases) {
    test(c.name, () => {
      const oracle = readFileSync(join(oracleDir, `${c.name}.ascii.txt`), "utf-8");
      const got = render(classified(c.path), { style: "ascii" });
      expect(got).toBe(oracle);
    });
  }
});
