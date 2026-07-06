// PAYLOAD TYPE-REF FAN-OUT CAP (SEAM_TYPEREF_FAN, opt-in) — the Acme serializer flood. A call-reached
// ENTITY (`User`) is expanded as a mechanism, and its @Type/column FIELDS pull in a WIDE fan of data-model TYPES
// (`*UserType`, serializers — dozens of leaves nothing CALLS). They bloat the footprint (and feed the coupling
// flywheel) with pure infra. The cap crops that type-ref fan-out while KEEPING the call/mechanism chain (grounded:
// type-ref vs call is a structural edge kind). Diagnosed the hard way: the flood is NOT a deep type-ref tree (the
// engine already stops type-ref at depth 1) but a WIDE fan-OUT off a call-reached entity. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

// Service CALLS User (a mechanism) which CALLS Helper (the chain that must survive); User also has 20 @Type
// serializer FIELDS (type-ref only — nothing calls them) = the payload fan the cap collapses.
const repo = join(tmpdir(), "seam-typeref-fan-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const SERS = Array.from({ length: 20 }, (_, i) => `Ser${i}Type`);

beforeAll(() => {
  w("ejb/Service.java", "package m;\npublic class Service { User user; public void run() { user.load(); } }\n");
  w("ejb/User.java", `package m;\npublic class User {\n  Helper helper;\n  public void load() { helper.work(); }\n${SERS.map((s) => `  ${s} f${s};`).join("\n")}\n}\n`);
  w("ejb/Helper.java", "package m;\npublic class Helper { public void work() {} }\n");
  for (const s of SERS) w(`ejb/${s}.java`, `package m;\npublic class ${s} {}\n`);
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

const grow = () => grow_to_terminals(repo, "ejb/Service.java", "Service", { dataCoupling: false, tierGrow: false, maxNodes: 200 } as any);
const files = (d: any) => new Set((d.nodes as any[]).map((n) => String(n.file).split("/").pop()));
const serCount = (d: any) => [...files(d)].filter((f) => /^Ser\d+Type\.java$/.test(f as string)).length;

describe("payload type-ref fan-out cap — collapse the entity's data-model type fan, keep the mechanism", () => {
  test("BASELINE (cap off): the entity's 20 payload type-ref fields all flood in", async () => {
    if (!available()) return;
    const [d]: [any, any[]] = await grow();
    expect(serCount(d)).toBe(20);
    expect(files(d).has("Helper.java")).toBe(true);
  });

  test("CAP (SEAM_TYPEREF_FAN=6): the payload fan is collapsed; the call chain (User→Helper) survives + a blindspot notes it", async () => {
    if (!available()) return;
    process.env.SEAM_TYPEREF_FAN = "6";
    try {
      const [d]: [any, any[]] = await grow();
      expect(serCount(d)).toBe(0);                       // the wide payload type fan is cropped
      expect(files(d).has("User.java")).toBe(true);      // the entity itself stays
      expect(files(d).has("Helper.java")).toBe(true);    // the CALL/mechanism chain is untouched (the private-app invariant)
      expect((d.blindspots ?? []).some((b: any) => b.mechanism === "payload-type-fan")).toBe(true);   // not silently dropped
    } finally { delete process.env.SEAM_TYPEREF_FAN; }
  });
});
