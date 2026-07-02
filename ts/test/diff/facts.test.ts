// Port of eval/facts_provider_test.py (parts 1,2,5) PLUS a differential oracle: the TS
// regex facts producer must emit byte-identical facts to the Python producer on the same
// real-diff fixtures (ts/test/diff/cases/*.patch). The Python output is captured in test/oracle/.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "../../src/diff/parser.js";
import * as noise from "../../src/diff/noise_filter.js";
import {
  ExternalFactsProvider, MergedFactsProvider, RegexFactsProvider,
  FACTS_SCHEMA_VERSION, facts_payload, factsFromDict, factsToDict, factsEqual,
} from "../../src/diff/facts.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const casesDir = join(__dir, "cases");
const oracleDir = join(__dir, "..", "oracle");
// Only oracle-BACKED cases: ts/test/diff/cases is shared with the eval harness corpus (many patches have
// no Python oracle — they're for scoring, not parity). Run parity on the ones with a parser oracle.
const cases = readdirSync(casesDir).filter((f) => f.endsWith(".patch")
  && existsSync(join(oracleDir, `${f.replace(/\.patch$/, "")}.parsed.json`)))
  .map((f) => f.replace(/\.patch$/, "")).sort();

function hunks(name: string) {
  const hs = parse(readFileSync(join(casesDir, `${name}.patch`), "utf-8"));
  noise.classify(hs); // marks noise in place
  return hs;
}

describe("parser + noise_filter vs Python oracle", () => {
  for (const name of cases) {
    test(name, () => {
      const oracle = JSON.parse(readFileSync(join(oracleDir, `${name}.parsed.json`), "utf-8"));
      const hs = hunks(name);
      expect(hs.length).toBe(oracle.length);
      hs.forEach((h, i) => {
        expect(h.id).toBe(oracle[i].id);
        expect(h.file_path).toBe(oracle[i].file_path);
        expect(h.change_type).toBe(oracle[i].change_type);
        expect(h.section_header).toBe(oracle[i].section_header);
        expect(h.role).toBe(oracle[i].role);
      });
    });
  }
});

describe("regex facts vs Python oracle (byte-identical payload)", () => {
  for (const name of cases) {
    test(name, async () => {
      const oracle = JSON.parse(readFileSync(join(oracleDir, `${name}.facts.json`), "utf-8"));
      const work = hunks(name).filter((h) => h.role !== "noise");
      const payload = await facts_payload(work, new RegexFactsProvider());
      // sort_keys parity: compare via canonical JSON.
      expect(JSON.parse(JSON.stringify(payload))).toEqual(oracle);
    });
  }
});

describe("HunkFacts round-trip + provider equivalence", () => {
  for (const name of cases) {
    test(`${name} round-trip`, async () => {
      const work = hunks(name).filter((h) => h.role !== "noise");
      const f = await new RegexFactsProvider().facts(work);
      for (const hf of f.values()) expect(factsEqual(factsFromDict(factsToDict(hf)), hf)).toBe(true);
    });

    test(`${name} external ≡ regex`, async () => {
      const work = hunks(name).filter((h) => h.role !== "noise");
      const rp = new RegexFactsProvider();
      const payload = await facts_payload(work, rp);
      expect((payload as any).version).toBe(FACTS_SCHEMA_VERSION);
      const ext = new ExternalFactsProvider(payload);
      const f1 = await rp.facts(work), f2 = await ext.facts(work);
      for (const h of work) expect(factsEqual(f1.get(h.id)!, f2.get(h.id)!)).toBe(true);
    });

    test(`${name} merged partial override`, async () => {
      const work = hunks(name).filter((h) => h.role !== "noise");
      if (!work.length) return;
      const rp = new RegexFactsProvider();
      const baseF = await rp.facts(work);
      const target = work[0].id;
      const other = work.length > 1 ? work[1].id : null;
      const mergePayload = { partial: true, fields: ["defines", "enclosing"],
        hunks: { [target]: { defines: ["SentinelDef"], enclosing: ["SentinelEnc"] } } };
      const mf = await new MergedFactsProvider(rp, mergePayload).facts(work);
      expect([...mf.get(target)!.defines]).toEqual(["SentinelDef"]);
      expect([...mf.get(target)!.enclosing]).toEqual(["SentinelEnc"]);
      expect(mf.get(target)!.decisions).toBe(baseF.get(target)!.decisions);
      expect(factsEqual(mf.get(target)!, baseF.get(target)!)).toBe(false);
      if (other) expect(factsEqual(mf.get(other)!, baseF.get(other)!)).toBe(true);
    });
  }
});
