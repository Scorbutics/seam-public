// CROSS-LANGUAGE clustering — the fix that collapses the Acme serializer flood. The shape clustering was
// JS/TS-centric: it keyed off a `member_expression` callee, but Java's `rs.getBytes()` is a `method_invocation`
// with an `object` field and Ruby's `Payment.where()` is a `call` with a `receiver` — no member node. So on
// Java/Ruby the flywheel saw EVERY blind file as its own singleton (40 `*UserType` serializers = 40 LLM calls).
// `_callReceiver` now extracts the receiver cross-grammar (member callee OR ≥2 name children before the args), so
// files sharing a receiver cluster into ONE rep. Recall-safe: same receiver ⇒ same channel; the rule grounds the
// rest via applyMatchers. Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { clusterBlindFiles } from "../../src/codebase/coupling/key_cluster.js";
import { available } from "../../src/codebase/atoms.js";

const sig = (cs: any[], recv: string) => cs.find((c) => c.signature === recv);

describe("cross-language coupling clustering (receiver extracted per grammar)", () => {
  test("Java @Type serializers sharing `rs`/`st` collapse to ONE rep (the Acme flood)", async () => {
    if (!available()) return;
    const sers = Array.from({ length: 8 }, (_, i) => ({
      file: `Ser${i}UserType.java`,
      text: `package m;\npublic class Ser${i}UserType {\n  public Object get(java.sql.ResultSet rs, String[] n) { return rs.getBytes(n[0]); }\n}\n`,
    }));
    const cs = await clusterBlindFiles(sers);
    const rs = sig(cs, "recv:rs");
    expect(rs).toBeDefined();
    expect(rs.members.length).toBe(8);   // 8 files → 1 rep (was 8 singletons = 8 LLM calls)
  });

  test("Ruby `Payment.where` and JS `prisma.x.find` / `localStorage.getItem` all extract a receiver", async () => {
    if (!available()) return;
    const cs = await clusterBlindFiles([
      { file: "report.rb", text: "class R\n def t\n  Payment.where(paid: true)\n end\nend\n" },
      { file: "a.ts", text: "export const f = (id: string) => prisma.booking.findUnique({ where: { id } });\n" },
      { file: "b.ts", text: "export const g = () => localStorage.getItem('k');\n" },
    ]);
    expect(sig(cs, "recv:Payment")).toBeDefined();       // Ruby receiver (was invisible → a singleton)
    expect(sig(cs, "recv:prisma")).toBeDefined();        // JS deep chain still works
    expect(sig(cs, "recv:localStorage")).toBeDefined();  // JS string-keyed still works
  });
});
