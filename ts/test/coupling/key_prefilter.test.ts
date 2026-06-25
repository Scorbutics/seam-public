// KEY-LITERAL PRE-FILTER — only floor-blind files that carry a distinctive KEY LITERAL (the necessary mark
// of a shared-key coupling: a route path, a table/topic/event/cache name) are worth an LLM scan. This cuts a
// module's floor-blind set to the handful that could be edges, without an import graph (works on globally-
// registered code). Recall-safe for the common case (the key literal lives in the coupling file).
import { describe, expect, test } from "bun:test";
import { _hasKeyLiteral } from "../../src/codebase/coupling/llm_key_index.js";

describe("_hasKeyLiteral — the data-coupling LLM pre-filter", () => {
  test("YES — files carrying a key literal (the coupling candidates)", () => {
    expect(_hasKeyLiteral('const baseUrl = "/acme/rest/member/booking/v1";')).toBe(true);   // route path (the indirection case)
    expect(_hasKeyLiteral('store.dispatch("booking.created")')).toBe(true);               // dotted topic
    expect(_hasKeyLiteral('from("member_bookings")')).toBe(true);                          // snake table
    expect(_hasKeyLiteral('emit("ORDER_PLACED")')).toBe(true);                             // CONSTANT key
    expect(_hasKeyLiteral('this.$emit("sub-entry-open")')).toBe(true);                     // kebab event
    expect(_hasKeyLiteral('Vue.http.get("/api/x")')).toBe(true);
  });
  test("NO — floor-blind files that cannot be a shared-key coupling (skipped)", () => {
    expect(_hasKeyLiteral('return h("div", "Click here to continue");')).toBe(false);      // prose / short labels
    expect(_hasKeyLiteral('function add(a, b) { return a + b; }')).toBe(false);            // no strings at all
    expect(_hasKeyLiteral('log("data"); log("the"); log("ok");')).toBe(false);             // only generic tokens
    expect(_hasKeyLiteral('const x = 42; const y = x * 2;')).toBe(false);
  });
});
