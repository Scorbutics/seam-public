// REGRESSION: extract_consumer_feeds (codebase/atoms.ts) used to hardcode JSX tree-sitter node kinds
// directly in that cross-language file. Moved to languages/typescript/jsx.ts, dispatched via the
// LanguageProvider registry's `consumerFeeds` field (keyed on FILE now, not a raw grammar-name string).
// Proves both ends of that dispatch: a JSX file still extracts prop feeds, and a language with no
// consumerFeeds capability (Java) returns nothing rather than throwing.
import { describe, expect, test } from "bun:test";
import { extract_consumer_feeds, available } from "../../src/codebase/atoms.js";

describe("extract_consumer_feeds — registry-dispatched JSX prop feeds", () => {
  test("a JSX tag matching the anchor yields its bound prop values", async () => {
    if (!available()) return;
    const content = `function Page() {\n  return <Booking id={selectedId} confirmed />;\n}\n`;
    const fed = await extract_consumer_feeds(content, "web/Page.tsx", "Booking");
    expect(fed.id?.[0]?.value).toBe("selectedId");
    expect(fed.confirmed?.[0]?.value).toBe("true");
  });

  test("a non-matching tag contributes nothing", async () => {
    if (!available()) return;
    const content = `function Page() {\n  return <Other id={x} />;\n}\n`;
    const fed = await extract_consumer_feeds(content, "web/Page.tsx", "Booking");
    expect(Object.keys(fed)).toEqual([]);
  });

  test("a language with no consumerFeeds capability (Java) returns {} instead of throwing", async () => {
    const content = `class Page { void render() { new Booking(id); } }\n`;
    const fed = await extract_consumer_feeds(content, "src/Page.java", "Booking");
    expect(fed).toEqual({});
  });
});
