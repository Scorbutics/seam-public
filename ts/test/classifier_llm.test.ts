// Phase 2 gate for the LLM cluster pass (Pass A), made deterministic via the host bus:
//  (1) PROMPT PARITY — TS build_cluster_prompt must be byte-identical to Python's.
//  (2) INJECT PARITY — fed the SAME canned reply through the host bus, TS engine.classify
//      (cluster=llm) must produce the same emit_seams_json as Python. Together these verify the
//      whole pass minus the (provider-shared) model call: same prompt in, same reply → same out.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "../src/diff/parser.js";
import * as noise from "../src/diff/noise_filter.js";
import { build_cluster_prompt } from "../src/diff/classifier_llm.js";
import { classify } from "../src/diff/engine.js";
import { emit_seams_json } from "../src/diff/seams.js";
import { HostBus, set_host_bus } from "../src/core/llm.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const oracleDir = join(__dir, "oracle");
const samplePatch = join(__dir, "..", "..", "sample.patch");
// Only oracle-BACKED cases: ts/test/cases is shared with the eval harness corpus (many patches have
// no Python oracle — they're for scoring, not parity). Run parity on the ones with a cluster oracle.
const caseFiles = readdirSync(join(__dir, "cases")).filter((f) => f.endsWith(".patch")
  && existsSync(join(oracleDir, "prompts", `${f.replace(/\.patch$/, "")}.cluster.txt`)));
const cases: { name: string; path: string }[] = [
  ...caseFiles.map((f) => ({ name: f.replace(/\.patch$/, ""), path: join(__dir, "cases", f) })),
  { name: "sample", path: samplePatch },
];

const workHunks = (path: string) => {
  const hs = parse(readFileSync(path, "utf-8"));
  noise.classify(hs);
  return hs;
};

describe("cluster prompt byte-parity vs Python", () => {
  for (const c of cases) {
    test(c.name, async () => {
      const oracle = readFileSync(join(oracleDir, "prompts", `${c.name}.cluster.txt`), "utf-8");
      const work = workHunks(c.path).filter((h) => h.role !== "noise");
      expect(build_cluster_prompt(work)).toBe(oracle);
    });
  }
});

describe("cluster inject-llm parity vs Python", () => {
  for (const c of cases) {
    test(c.name, async () => {
      const reply = readFileSync(join(oracleDir, "inject", `${c.name}.reply.json`), "utf-8");
      const oracle = JSON.parse(readFileSync(join(oracleDir, "inject", `${c.name}.seams.json`), "utf-8"));
      const hs = workHunks(c.path);
      set_host_bus(new HostBus({ cluster: reply }));
      try { await classify(hs, { cluster: "llm", roles: "det", wiring: "det" }); }
      finally { set_host_bus(null); }
      expect(JSON.parse(JSON.stringify(await emit_seams_json(hs)))).toEqual(oracle);
    });
  }
});
