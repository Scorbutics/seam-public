// JAVA dispatch — the THIN grammar layer over the shared simple-name dispatch (core/dispatch). All the
// resolution machinery (ancestor lookup, by-name tiering, the index walk) is generic; this file only
// says which Java nodes are classes/methods and how to read their names, parents, and declared types.
// Java declares types (`Store s`, `void m(Store s)`, `new Store()`), so receiver-type inference is precise.
import { collectByType, field, getParser } from "../../core/treesitter.js";
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../core/resolve/languages/base.js";
import {
  buildSimpleIndex, resolveSelf, resolveSimpleCall,
  type DispatchIndex, type IndexGrammar, type MethodCandidate,
} from "../../core/dispatch.js";

export type JavaIndex = DispatchIndex;
export type { MethodCandidate } from "../../core/dispatch.js";

const _DYNAMIC = new Set(["invoke"]);   // reflection (Method.invoke) — truly dynamic, an honest blindspot
export const isDynamicDispatch = (method: string): boolean => _DYNAMIC.has(method);

// A type reference node → its simple name: identifier / type_identifier / scoped(_type)_identifier
// (`a.b.C` → "C") / generic_type (`List<X>` → "List").
export function typeName(n: any): string | null {
  if (!n) return null;
  if (n.type === "identifier" || n.type === "type_identifier") return n.text;
  if (n.type === "scoped_identifier" || n.type === "scoped_type_identifier") return field(n, "name")?.text ?? null;
  if (n.type === "generic_type") return typeName(n.namedChild(0));
  return null;
}
const _isStatic = (n: any): boolean => { for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c.type === "modifiers") return c.text.includes("static"); } return false; };

const GRAMMAR: IndexGrammar = {
  containerKinds: new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"]),
  methodKinds: new Set(["method_declaration", "constructor_declaration"]),
  className: (n) => field(n, "name")?.text ?? null,
  parentNames: (n) => {
    const out: string[] = [];
    const sc = field(n, "superclass");
    if (sc) { const s = typeName(sc.namedChildCount ? sc.namedChild(0) : sc); if (s) out.push(s); }
    const ifs = field(n, "interfaces");
    if (ifs) for (const t of collectByType(ifs, "type_identifier")) out.push(t.text);
    return out;
  },
  methodName: (n, container) => n.type === "constructor_declaration" ? container : (field(n, "name")?.text ?? null),
  methodKind: (n) => _isStatic(n) ? "class" : "instance",
};

export async function buildJavaIndex(repo: string): Promise<JavaIndex> {
  const parser = await getParser("java");
  if (!parser) return new Map();
  const roots: { root: any; file: string }[] = [];
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, (r) => r.endsWith(".java"))) {
    try { roots.push({ root: parser.parse(text).rootNode, file: rel }); } catch { /* skip parse failures */ }
  }
  return buildSimpleIndex(roots, GRAMMAR);
}

// Declared-type bindings (local vars, fields, formal params) → a {name → simple type} map. Precise:
// Java declarations carry the type, so no factory registry is needed for the common case.
export function inferAssignments(root: any): Map<string, string> {
  const typeOf = new Map<string, string>();
  const visit = (n: any) => {
    if (n.type === "local_variable_declaration" || n.type === "field_declaration") {
      const t = typeName(field(n, "type"));
      if (t) for (let i = 0; i < n.namedChildCount; i++) { const d = n.namedChild(i); if (d.type === "variable_declarator") { const nm = field(d, "name")?.text; if (nm) typeOf.set(nm, t); } }
    } else if (n.type === "formal_parameter") {
      const t = typeName(field(n, "type")), nm = field(n, "name")?.text;
      if (t && nm) typeOf.set(nm, t);
    }
    for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
  };
  visit(root);
  return typeOf;
}

export const resolveMethodCall = (index: JavaIndex, recvExpr: string, method: string, typeOf: Map<string, string>): MethodCandidate[] => resolveSimpleCall(index, recvExpr, method, typeOf);
export const resolveSelfCall = (index: JavaIndex, className: string, method: string): MethodCandidate[] => resolveSelf(index, className, method);
