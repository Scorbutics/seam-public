// Port of src/core/resolve/languages/python.py — import discovery (bare `from .x import`). No
// deterministic floor (resolve=undefined): resolution relies on the LSP (source=null ImportRefs).
import { bun_x, type ImportRef, type LanguageProvider } from "../../core/resolve/languages/base.js";

const _FROM_RE = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/d;
const _IMPORT_RE = /^\s*import\s+(.+)$/;

function parse_imports(text: string): [string, number, number][] {
  const out: [string, number, number][] = [];
  text.split("\n").forEach((line, i) => {
    const fm = line.match(_FROM_RE);
    if (fm) {
      const g2start = (fm as any).indices[2][0] as number;
      for (const seg of fm[2].split("#")[0].split(",")) {
        const orig = seg.trim().replace(/^\(|\)$/g, "").split(" as ")[0].trim();
        if (orig && orig !== "*") {
          const col = line.indexOf(orig, g2start);
          out.push([orig, i, col >= 0 ? col : g2start]);
        }
      }
      return;
    }
    const im = line.match(_IMPORT_RE);
    if (im && !line.replace(/^\s+/, "").startsWith("from")) {
      for (const seg of im[1].split("#")[0].split(",")) {
        const orig = seg.trim().split(" as ")[0].trim().split(".")[0];
        if (orig) out.push([orig, i, line.indexOf(orig)]);
      }
    }
  });
  return out;
}

function imports(text: string): ImportRef[] {
  return parse_imports(text).map(([name, line, col]) => ({ name, local: name, line, col, source: null }));
}

// Main entry inside a Python module: `if __name__ == '__main__':` → a top-level call → else the
// first top-level statement that isn't a comment/import.
function _entrypoint(ctx: any): number | null {
  const top = ctx.children(ctx.root);
  const main = top.find((n: any) => n.type === "if_statement" && ctx.text(n).slice(0, 80).includes("__main__"));
  if (main) return ctx.span(main)[0];
  const call = top.find((n: any) => n.type === "expression_statement" && ctx.children(n).length && ctx.children(n)[0].type.includes("call"));
  if (call) return ctx.span(call)[0];
  const real = top.find((n: any) => !["comment", "import_statement", "import_from_statement", "future_import_statement"].includes(n.type));
  return real ? ctx.span(real)[0] : null;
}

export const PROVIDER: LanguageProvider = {
  name: "python", extensions: [".py", ".pyi"], imports, moduleEntry: /^__init__\.py$/, entrypoint: _entrypoint, implMarkers: [],
  lsp: {
    language: "python",
    command: bun_x("--package", "pyright", "pyright-langserver", "--stdio"),
    languageId: "python",
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    status: "scaffold",
    notes: "Phase 2. pyright via bun x; venv detection (python.venvPath/pythonPath).",
  },
};
