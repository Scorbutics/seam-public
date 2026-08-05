// `enumerateDefs` must carry the declaration LINE.
//
// `seam_scan::Def` has had a 0-based `line` since --locate needed to cite one, but the napi DTO omitted it, so
// every JS caller read `undefined`. That fails silently in the worst way: a "which symbol serves line N" lookup
// compares `undefined + 1 <= N`, resolves nothing, and reports no match rather than an error — which is exactly
// how it cost a debugging cycle here, with the caller looking broken instead of the wire shape.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadAddon } from "../../src/codebase/rust_core.js";

describe("enumerateDefs carries the declaration line", () => {
  test("a def's line locates it in the file, 0-based", () => {
    const repo = mkdtempSync(join(tmpdir(), "def-line-"));
    try {
      writeFileSync(join(repo, "package.json"), `{ "name": "dl", "version": "1.0.0" }`);
      const p = join(repo, "src", "a.ts");
      mkdirSync(dirname(p), { recursive: true });
      // `second` is declared on the 4th line, i.e. index 3
      writeFileSync(p, ["export function first() { return 1; }", "", "", "export function second() { return 2; }"].join("\n"));
      const defs = (loadAddon() as any).enumerateDefs(repo, 100, ["src/a.ts"], false) as any[];
      const second = defs.find((d) => d.name === "second");
      expect(second, `no def named 'second'; got ${defs.map((d) => d.name).join(",")}`).toBeDefined();
      expect(typeof second.line, "the DTO dropped `line` — JS callers silently read undefined").toBe("number");
      expect(second.line).toBe(3);
      expect(defs.find((d) => d.name === "first").line).toBe(0);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
