// Phase 4 gate: Pass B (role/span voting), Pass C (wiring), and the all-LLM/all-hybrid engines
// (--classifier llm / hybrid), made deterministic via the host bus serving every pass:
//  (1) PROMPT PARITY — role prompt + wire prompt byte-identical to Python.
//  (2) INJECT PARITY — same canned replies → identical emit_seams for --classifier llm AND hybrid.
//  (3) aggregate_role_votes (the self-consistency medoid) vs Python on DIFFERING votes.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, type Hunk } from "../src/diff/parser.js";
import * as noise from "../src/diff/noise_filter.js";
import * as det from "../src/diff/classifier_det.js";
import { build_role_prompt, build_wire_prompt, aggregate_role_votes } from "../src/diff/classifier_llm.js";
import { RegexFactsProvider } from "../src/diff/facts.js";
import { classify } from "../src/diff/engine.js";
import { emit_seams_json } from "../src/diff/seams.js";
import { HostBus, set_host_bus } from "../src/core/llm.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const p4 = join(__dir, "oracle", "p4");
const samplePatch = join(__dir, "..", "..", "sample.patch");
const caseFiles = readdirSync(join(__dir, "cases")).filter((f) => f.endsWith(".patch"));
const cases = [...caseFiles.map((f) => ({ name: f.replace(/\.patch$/, ""), path: join(__dir, "cases", f) })),
  { name: "sample", path: samplePatch }];

const load = (p: string): Hunk[] => { const hs = parse(readFileSync(p, "utf-8")); noise.classify(hs); return hs; };

describe("role prompt (Pass B) byte-parity", () => {
  for (const c of cases) test(c.name, () => {
    const work = load(c.path).filter((h) => h.role !== "noise");
    expect(build_role_prompt(work)).toBe(readFileSync(join(p4, `${c.name}.role.txt`), "utf-8"));
  });
});

describe("wire prompt (Pass C) byte-parity", () => {
  for (const c of cases) test(c.name, () => {
    const work = load(c.path).filter((h) => h.role !== "noise");
    det.assign_roles(work, new RegexFactsProvider().facts(work));   // wire prompt needs roles
    expect(build_wire_prompt(work)).toBe(readFileSync(join(p4, `${c.name}.wire.txt`), "utf-8"));
  });
});

describe("--classifier llm inject parity", () => {
  for (const c of cases) test(c.name, () => {
    const answers = JSON.parse(readFileSync(join(p4, `${c.name}.llm.answers.json`), "utf-8")).answers;
    const oracle = JSON.parse(readFileSync(join(p4, `${c.name}.llm.seams.json`), "utf-8"));
    const hs = load(c.path);
    set_host_bus(new HostBus(answers));
    try { classify(hs, { cluster: "llm", roles: "llm", wiring: "llm" }); }
    finally { set_host_bus(null); }
    expect(JSON.parse(JSON.stringify(emit_seams_json(hs)))).toEqual(oracle);
  });
});

describe("--classifier hybrid inject parity", () => {
  for (const c of cases) test(c.name, () => {
    const answers = JSON.parse(readFileSync(join(p4, `${c.name}.hybrid.answers.json`), "utf-8")).answers;
    const oracle = JSON.parse(readFileSync(join(p4, `${c.name}.hybrid.seams.json`), "utf-8"));
    const hs = load(c.path);
    set_host_bus(new HostBus(answers));
    try { classify(hs, { cluster: "hybrid", roles: "hybrid", wiring: "hybrid" }); }
    finally { set_host_bus(null); }
    expect(JSON.parse(JSON.stringify(emit_seams_json(hs)))).toEqual(oracle);
  });
});

describe("aggregate_role_votes medoid vs Python", () => {
  const votes = JSON.parse(readFileSync(join(p4, "votes.json"), "utf-8"));
  votes.forEach((v: any, i: number) => test(`case ${i}`, () => {
    const runs = v.runs.map((r: any) => new Map<string, any>(Object.entries(r)));
    const [medoid, conf] = aggregate_role_votes(runs, v.ids);
    expect(Object.fromEntries(medoid)).toEqual(v.medoid);
    expect(Object.fromEntries(conf)).toEqual(v.conf);
  }));
});
