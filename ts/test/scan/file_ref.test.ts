// FILE-PATH REFERENCE resolution — the framework-agnostic component↔file link. A string literal that
// resolves to an EXISTING repo file (`templateUrl`/`styleUrls`/asset paths) becomes a dependency edge,
// keyed purely on "a path that points at a real file" — no framework or property name anywhere, so the
// SAME code links AngularJS `.js`→`.html`, Angular `.ts`→`.html`/`.css`, etc. A URL / non-path string / a
// path that points nowhere yields NO edge (no false positives). The dependency pass gates on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isPathLiteral, resolveFileRef } from "../../src/core/resolve/file_ref.js";
import { build_dependency_graph } from "../../src/codebase/scan/dependency_graph.js";
import { available } from "../../src/codebase/atoms.js";

describe("isPathLiteral — cheap pre-filter", () => {
  test("accepts relative paths with a file extension", () => {
    for (const ok of ["./foo.html", "../x/bar.css", "components/foo.html", "logo.svg", "a/b/c.component.html"])
      expect(isPathLiteral(ok)).toBe(true);
  });
  test("rejects URLs, bare words, whitespace, extensionless", () => {
    for (const bad of ["https://example.com/x", "data:image/png;base64,AAAA", "refreshSection", "some text.js here", "components/foo", ""])
      expect(isPathLiteral(bad)).toBe(false);
  });
});

describe("resolveFileRef — exists-gated, file-relative then repo-root", () => {
  const REPO = join(tmpdir(), "seam-fref-unit-" + process.pid);
  const w = (rel: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), "x"); };
  beforeAll(() => { rmSync(REPO, { recursive: true, force: true }); w("components/foo.html"); w("ng2/x.component.css"); });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("file-relative `./x.css`", () => {
    expect(resolveFileRef(REPO, "ng2/x.component.ts", "./x.component.css")).toBe("ng2/x.component.css");
  });
  test("repo-root-relative `components/foo.html`", () => {
    expect(resolveFileRef(REPO, "components/fooDirective.js", "components/foo.html")).toBe("components/foo.html");
  });
  test("a path that points nowhere → null (no false edge)", () => {
    expect(resolveFileRef(REPO, "components/fooDirective.js", "components/missing.html")).toBeNull();
    expect(resolveFileRef(REPO, "a.ts", "https://example.com/x.html")).toBeNull();   // URL filtered
  });
});

describe("dependency pass — one resolver links every framework's component to its files", () => {
  const REPO = join(tmpdir(), "seam-fref-dep-" + process.pid);
  const w = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    // AngularJS: directive declares its template by repo-root-relative path
    w("components/fooDirective.js", "angular.module('app').directive('fooWidget', function () {\n  return { templateUrl: 'components/foo.html' };\n});\n");
    w("components/foo.html", "<div>foo</div>\n");
    // Angular 2+: @Component declares template + styles by file-relative path; a URL must NOT link
    w("ng2/file-note.component.ts", "@Component({ templateUrl: './file-note.component.html', styleUrls: ['./file-note.component.css'] })\nexport class FileNoteComponent { url = 'https://example.com/x'; }\n");
    w("ng2/file-note.component.html", "<button>x</button>\n");
    w("ng2/file-note.component.css", ".x{color:red}\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  const targets = async (file: string, sym: string) => {
    const g: any = await build_dependency_graph(REPO, file, sym, {});
    return new Map((g.nodes ?? []).filter((n: any) => n.id !== "n1").map((n: any) => [n.file, (g.edges ?? []).find((e: any) => e.to === n.id)?.kind]));
  };

  test("AngularJS .js directive → its .html template (file-ref edge)", async () => {
    if (!available()) return;
    const t = await targets("components/fooDirective.js", "fooWidget");
    expect(t.get("components/foo.html")).toBe("file-ref");
  });
  test("Angular .ts component → its .html AND .css; a URL is not linked", async () => {
    if (!available()) return;
    const t = await targets("ng2/file-note.component.ts", "FileNoteComponent");
    expect(t.get("ng2/file-note.component.html")).toBe("file-ref");
    expect(t.get("ng2/file-note.component.css")).toBe("file-ref");
    expect([...t.keys()].some((f) => String(f).includes("example.com"))).toBe(false);
  });
});
