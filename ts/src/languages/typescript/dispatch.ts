// TYPESCRIPT/JS dispatch — the THIN grammar layer over the shared simple-name dispatch (core/dispatch).
// Only the TS specifics live here: which nodes are classes/methods/top-level-functions, how to read
// extends/implements, and receiver-type inference from `new` expressions (`const s = new Store()`).
import { collectByType, field, getParser } from "../../core/treesitter.js";
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../core/resolve/languages/base.js";
import {
  buildSimpleIndex, resolveSelf, resolveSimpleCall,
  type DispatchIndex, type IndexGrammar, type MethodCandidate,
} from "../../core/dispatch.js";

export type TsIndex = DispatchIndex;
export { MODULE } from "../../core/dispatch.js";
export type { MethodCandidate } from "../../core/dispatch.js";

export const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
export const grammarFor = (file: string): string => file.endsWith(".tsx") ? "tsx" : (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts")) ? "typescript" : "javascript";

const _DYNAMIC = new Set(["call", "apply"]);      // Function.prototype.call/apply defeat static dispatch
export const isDynamicDispatch = (method: string): boolean => _DYNAMIC.has(method);

const _ctorName = (newExpr: any): string | null => { const c = field(newExpr, "constructor"); return c && (c.type === "identifier" || c.type === "type_identifier") ? c.text : null; };

const GRAMMAR: IndexGrammar = {
  containerKinds: new Set(["class_declaration", "class"]),
  methodKinds: new Set(["method_definition"]),
  moduleMethodKinds: new Set(["function_declaration"]),
  className: (n) => field(n, "name")?.text ?? null,
  parentNames: (n) => {
    const out: string[] = [];
    for (let i = 0; i < n.namedChildCount; i++) {
      const h = n.namedChild(i);
      if (h.type !== "class_heritage") continue;
      for (let j = 0; j < h.namedChildCount; j++) {
        const cl = h.namedChild(j);
        if (cl.type === "extends_clause") { const v = field(cl, "value") ?? cl.namedChild(0); if (v?.text) out.push(v.text); }
        if (cl.type === "implements_clause") for (const t of collectByType(cl, "type_identifier")) out.push(t.text);
      }
    }
    return out;
  },
  methodName: (n) => field(n, "name")?.text ?? null,
  methodKind: () => "instance",
};

export async function buildTsIndex(repo: string): Promise<TsIndex> {
  const roots: { root: any; file: string }[] = [];
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, (r) => EXTENSIONS.some((e) => r.endsWith(e)))) {
    const parser = await getParser(grammarFor(rel));
    if (!parser) continue;
    try { roots.push({ root: parser.parse(text).rootNode, file: rel }); } catch { /* skip parse failures */ }
  }
  return buildSimpleIndex(roots, GRAMMAR);
}

// `name = new Const(...)` bindings: `const s = new Store()`, class field `s = new Store()`, and
// `this.s = new Store()` → a {name → type} map.
export function inferAssignments(root: any): Map<string, string> {
  const typeOf = new Map<string, string>();
  const visit = (n: any) => {
    if (n.type === "variable_declarator" || n.type === "public_field_definition") {
      const val = field(n, "value"), nm = field(n, "name");
      if (val?.type === "new_expression" && (nm?.type === "identifier" || nm?.type === "property_identifier")) { const t = _ctorName(val); if (t) typeOf.set(nm.text, t); }
    } else if (n.type === "assignment_expression") {
      const left = field(n, "left"), right = field(n, "right");
      if (right?.type === "new_expression" && left?.type === "member_expression" && field(left, "object")?.type === "this") { const t = _ctorName(right); const p = field(left, "property")?.text; if (t && p) typeOf.set(p, t); }
    }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
  };
  visit(root);
  return typeOf;
}

export const resolveMethodCall = (index: TsIndex, recvExpr: string, method: string, typeOf: Map<string, string>): MethodCandidate[] => resolveSimpleCall(index, recvExpr, method, typeOf);
export const resolveSelfCall = (index: TsIndex, className: string, method: string): MethodCandidate[] => resolveSelf(index, className, method);
