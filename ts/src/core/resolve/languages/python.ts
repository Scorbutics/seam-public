// Port of src/core/resolve/languages/python.py — import discovery (bare `from .x import`). No
// deterministic floor (resolve=undefined): resolution relies on the LSP (source=null ImportRefs).
import type { ImportRef, LanguageProvider } from "./base.js";

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

export const PROVIDER: LanguageProvider = {
  name: "python", extensions: [".py", ".pyi"], imports, moduleEntry: /^__init__\.py$/,
};
