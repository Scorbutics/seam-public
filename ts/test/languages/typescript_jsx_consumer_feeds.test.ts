// CONSUMER FEEDS across the napi boundary — what a caller binds into the anchor's props.
//
// The extraction and its dispatch now live in the core: `seam_lang::atoms::extract_consumer_feeds` asks the
// file's LanguageProvider, and only the TypeScript one implements it (JSX node kinds are one grammar's, which
// is why they never belonged in the cross-language atoms module). Those claims are pinned in Rust, plus a
// differential harness over `test/fixtures/jsx-feeds` (`rust/parity/feeds.ts`).
//
// Asserted HERE is the wire: the flat `[prop, value, line, valLine, valCol]` row order that
// `detect_consumer_feeds` reads POSITIONALLY, and the one field that must stay EMPTY rather than zero.
import { describe, expect, test } from "bun:test";
import { loadAddon } from "../../src/codebase/rust_core.js";
import { available } from "../../src/codebase/atoms.js";

const addon = loadAddon();
const feeds = (content: string, file: string, anchor: string): string[][] =>
  (addon?.extractConsumerFeeds(content, file, anchor) ?? []) as string[][];

describe("consumer feeds — the registry-dispatched JSX rows detect_consumer_feeds reads", () => {
  test("a matching tag yields its bound prop values, positionally", () => {
    if (!available() || !addon) return;
    const content = `function Page() {\n  return <Booking id={selectedId} confirmed />;\n}\n`;
    const rows = feeds(content, "web/Page.tsx", "Booking");
    const byProp = new Map(rows.map((r) => [r[0], r]));

    const id = byProp.get("id")!;
    expect(id[1]).toBe("selectedId");        // value, braces unwrapped
    expect(Number(id[2])).toBe(1);           // the attribute's line
    expect(id[3]).not.toBe("");              // a value expression exists → it has a position
    expect(Number(id[4])).toBeGreaterThan(0);

    // A BARE attribute is JSX shorthand for `true` and has NO value node. valLine/valCol must be EMPTY, not
    // "0" — `detect_consumer_feeds` tests `valLine !== ""` to decide whether to attach a position, and a zero
    // there would send a reader to line 0 of the consumer, which is real code and the wrong code.
    const confirmed = byProp.get("confirmed")!;
    expect(confirmed[1]).toBe("true");
    expect(confirmed[3]).toBe("");
    expect(confirmed[4]).toBe("");
  });

  test("a non-matching tag contributes nothing", () => {
    if (!available() || !addon) return;
    expect(feeds(`function Page() {\n  return <Other id={x} />;\n}\n`, "web/Page.tsx", "Booking")).toEqual([]);
  });

  test("a language with no attribute-binding concept returns nothing rather than throwing", () => {
    if (!addon) return;
    // Java passes arguments positionally — there is no tag whose attributes name the callee's parameters, so
    // an empty answer is the honest one, not a gap
    expect(feeds(`class Page { void render() { new Booking(id); } }\n`, "src/Page.java", "Booking")).toEqual([]);
  });
});
