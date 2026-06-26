// FILE SNIPPET = structural HEAD ⊕ deep string-key windows. Pins the three contracts: the head is always
// sent (so a class/model/controller near the top — ActiveRecord, an implicit route — is still inferred), a
// string-keyed coupling PAST the old 4 KB cut is captured (recall hole closed), and a commented-out literal
// past the head is masked (not a window).
import { describe, expect, test } from "bun:test";
import { candidatePassages } from "../../src/codebase/coupling/llm_key_index.js";

describe("per-file snippet — head ⊕ string-key windows", () => {
  test("a string-keyed call PAST the old 4 KB head is captured (recall hole closed)", () => {
    const filler = "const noise = 1;\n".repeat(400);   // ~6.8 KB of boilerplate before the real site
    const text = filler + `bus.emit('orders.sync', payload);\n`;
    const p = candidatePassages(text, 12000);
    expect(p).toContain("orders.sync");                  // the deep site is included
    expect(p.length).toBeLessThan(text.length);         // …without sending the whole file (middle dropped)
  });

  test("the structural HEAD is always sent (class/model/controller context preserved)", () => {
    const text = `class Payment < ApplicationRecord\n` + "  attr_accessor :x\n".repeat(500) + `end\n`;
    const p = candidatePassages(text, 12000);
    expect(p).toContain("class Payment");                // head → ActiveRecord/route inference still works
    expect(p.length).toBeLessThan(text.length);         // big inert middle dropped
  });

  test("a literal in a COMMENT past the head is masked — no window", () => {
    const head = "const x = 1;\n".repeat(70);            // > 700 chars → head ends before the lines below
    const text = head + "const filler = 0;\n".repeat(40) + `// bus.emit('commented') marker\n` + "const z = 0;\n".repeat(40) + `bus.emit('real-key');\n`;
    const p = candidatePassages(text, 20000);
    expect(p).toContain("real-key");                     // a real deep site → window
    expect(p).not.toContain("commented");                // a commented literal past the head → masked, no window
  });
});
