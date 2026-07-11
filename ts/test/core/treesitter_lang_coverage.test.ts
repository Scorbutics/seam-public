// core/treesitter.ts's _LANG_BY_EXT is a hand-kept ext→grammar table, separate from the canonical
// LanguageProvider registry (core/resolve/languages/index.ts) because a provider's extensions can split
// across multiple grammars (TS's .tsx is its own grammar). That split means it can't be derived
// programmatically — so this test is the enforcement instead: every extension the registry considers a
// SOURCE file must resolve to a tree-sitter grammar, catching the exact drift (missing .mts/.cts/.pyi/.rake)
// a prior audit found.
import { describe, expect, test } from "bun:test";
import { langForExt } from "../../src/core/treesitter.js";
import { SOURCE_EXTS } from "../../src/core/resolve/languages/index.js";

describe("treesitter language coverage vs the canonical registry", () => {
  test("every registered source extension has a tree-sitter grammar mapping", () => {
    const missing = SOURCE_EXTS.filter((ext) => langForExt(ext) === null);
    expect(missing).toEqual([]);
  });
});
