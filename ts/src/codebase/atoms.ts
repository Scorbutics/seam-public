// Port of src/codebase/atoms.py — the tree-sitter substrate for intra-anchor decomposition.
// web-tree-sitter is async, so _Ctx is built via an async factory and the extractors are async.
// Node accessors are PROPERTIES here (n.type/startIndex/childCount/child(i)) vs the Python binding's
// callables. Offsets are UTF-16 code units; line/col are counted in the string (matches per the
// tree-sitter facts reasoning — line counts are unit-agnostic).
import { available as isAvailable, getParser, langForExt } from "../core/treesitter.js";
const langForExtAtoms = langForExt;

// --- per-grammar node-kind registry (concepts, never literal TSX kinds) ----------------------
export const _FUNCLIKE = new Set(["arrow_function", "function_declaration", "function_expression", "method_definition",
  "generator_function_declaration", "function_signature", "function_definition", "lambda_expression",
  "method_declaration", "constructor_declaration", "function_item", "closure_expression", "lambda", "function", "method"]);
const _BODY = new Set(["statement_block", "compound_statement", "block", "constructor_body", "function_body", "do_block"]);
const _PARAM_LIST = new Set(["formal_parameters", "parameter_list", "parameters", "method_parameters"]);
const _PARAM_NODE = new Set(["required_parameter", "optional_parameter", "rest_pattern",
  "parameter_declaration", "optional_parameter_declaration", "formal_parameter", "spread_parameter",
  "receiver_parameter", "typed_parameter", "default_parameter", "typed_default_parameter", "parameter"]);
export const _CALL = new Set(["call_expression", "method_invocation", "call", "invocation_expression"]);
// class / member / instantiation vocabulary (shared with import_scan). "Class-like" = any NAMED TYPE
// declaration that can be imported/depended on — incl. interfaces/enums/records (Java + TS), not just
// concrete classes. Without this, an imported interface (the common DI/abstraction target, e.g. a
// repository or service interface) isn't recognised as a def, so the dependency edge to it is dropped.
export const _CLASS_KINDS = new Set(["class_declaration", "abstract_class_declaration", "class_definition",
  "class_specifier", "struct_specifier", "interface_declaration", "enum_declaration", "record_declaration"]);
export const _METHOD_KINDS = new Set(["method_definition", "method_declaration", "constructor_declaration"]);
export const _NAME_KINDS = new Set(["identifier", "property_identifier", "type_identifier"]);
export const _MEMBER = new Set(["member_expression", "attribute", "field_access", "selector_expression", "field_expression"]);
export const _MEMBER_NAME = new Set(["property_identifier", "field_identifier"]);
export const _NEW = new Set(["new_expression", "object_creation_expression"]);
export const _TYPE_REF = new Set(["type_identifier"]);
export const _INSTANCE_BINDER = new Set(["variable_declarator", "required_parameter", "optional_parameter",
  "public_field_definition", "field_definition", "property_signature"]);
export const _VAR_DECL = new Set(["lexical_declaration", "variable_declaration"]);
export const _INTERFACE = new Set(["interface_declaration"]);
export const _INTERFACE_MEMBER = new Set(["method_signature", "property_signature", "abstract_method_signature"]);
// The `extends`-bases clause of a class, cross-language: TS extends_clause, Java superclass, Python
// argument_list. We read its DIRECT name children only (so a base's generic args / an implements
// clause are not mistaken for bases). _BASE_NAME = the kinds a base reference can take.
export const _HERITAGE = new Set(["extends_clause", "superclass", "base_class_clause", "argument_list", "extends_interfaces"]);
export const _BASE_NAME = new Set(["identifier", "type_identifier", "member_expression", "scoped_identifier", "scoped_type_identifier"]);
// `implements` clause kinds (a CLASS → the interfaces it implements): Java `super_interfaces` (names
// nested under a `type_list`), TS `implements_clause` (nested under `class_heritage`). Kept DISTINCT
// from _HERITAGE (which is `extends` only) so interface→impl resolution reads the implements relation.
export const _IMPLEMENTS = new Set(["super_interfaces", "implements_clause"]);
export const _EXPORT = new Set(["export_statement"]);
export const _ANON_FUNC = new Set(["arrow_function", "function_expression", "lambda", "lambda_expression", "closure_expression"]);
export const _VAR_DECLARATOR = new Set(["variable_declarator", "assignment"]);
export const available = isAvailable;

export interface Atom { start: number; end: number; names: Set<string>; }
export interface ContractMember { name: string; invoked: boolean; ranges: number[][]; }

export function lang_for(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  return langForExtAtoms(dot >= 0 ? filePath.slice(dot).toLowerCase() : "");
}

export class Ctx {
  constructor(public content: string, public root: any) {}
  ln(off: number): number { let c = 0; for (let i = 0; i < off && i < this.content.length; i++) if (this.content[i] === "\n") c++; return c; }
  span(n: any): [number, number] { return [this.ln(n.startIndex), this.ln(n.endIndex)]; }
  children(n: any): any[] { const out: any[] = []; for (let i = 0; i < n.childCount; i++) { const c = n.child(i); if (c) out.push(c); } return out; }
  text(n: any): string { return this.content.slice(n.startIndex, n.endIndex); }
  col(off: number): number { return off - (this.content.lastIndexOf("\n", off - 1) + 1); }
  collect(root: any, pred: (k: string) => boolean): any[] {
    const out: any[] = []; const st = [root];
    while (st.length) { const x = st.pop(); if (pred(x.type)) out.push(x); st.push(...this.children(x)); }
    return out;
  }
}

export async function makeCtx(content: string, grammar: string): Promise<Ctx | null> {
  const parser = await getParser(grammar);
  if (!parser) return null;
  try { return new Ctx(content, parser.parse(content).rootNode); } catch { return null; }
}

function _anchor_func(ctx: Ctx, startLine: number): any | null {
  const funcs = ctx.collect(ctx.root, (k) => _FUNCLIKE.has(k));
  if (!funcs.length) return null;
  const key = (n: any): [number, number] => { const [s, e] = ctx.span(n); return [Math.abs(s - startLine), -(e - s)]; };
  const af = funcs.reduce((a, b) => { const ka = key(a), kb = key(b); return (kb[0] < ka[0] || (kb[0] === ka[0] && kb[1] < ka[1])) ? b : a; });
  return Math.abs(ctx.span(af)[0] - startLine) <= 3 ? af : null;
}

function _body_of(ctx: Ctx, func: any): any {
  for (const c of ctx.children(func)) if (_BODY.has(c.type)) return c;
  return func;
}

function _param_list(ctx: Ctx, func: any): any | null {
  const queue = ctx.children(func);
  while (queue.length) {
    const c = queue.shift()!;
    const k = c.type;
    if (_PARAM_LIST.has(k)) return c;
    if (_BODY.has(k) || _FUNCLIKE.has(k)) continue;
    queue.push(...ctx.children(c));
  }
  return null;
}

function _param_names(ctx: Ctx, paramNode: any): string[] {
  const fields = ctx.collect(paramNode, (k) => k.includes("shorthand_property_identifier_pattern"));
  if (fields.length) return fields.map((f) => ctx.text(f));
  const ids = ctx.collect(paramNode, (k) => k === "identifier").sort((a, b) => a.startIndex - b.startIndex);
  return ids.length ? [ctx.text(ids[ids.length - 1])] : [];
}

function _merge_lines(lines: number[]): number[][] {
  const out: number[][] = [];
  for (const l of [...new Set(lines)].sort((a, b) => a - b)) {
    if (out.length && l <= out[out.length - 1][1] + 1) out[out.length - 1][1] = l;
    else out.push([l, l]);
  }
  return out;
}

export async function extract_atoms(content: string, lang: string, startLine: number, endLine: number): Promise<Atom[]> {
  if (!isAvailable()) return [];
  const ctx = await makeCtx(content, lang);
  if (!ctx) return [];
  const func = _anchor_func(ctx, startLine);
  if (!func) return [];
  const body = _body_of(ctx, func);
  const funcs: any[] = [];
  const walk = (n: any) => { for (const c of ctx.children(n)) { if (_FUNCLIKE.has(c.type)) funcs.push(c); else walk(c); } };
  walk(body);
  const atoms: Atom[] = [];
  for (const n of funcs) {
    const [s, e] = ctx.span(n);
    if (s < startLine || e > endLine) continue;
    const names = new Set(ctx.collect(n, (k) => k.includes("identifier")).map((i) => ctx.text(i)));
    atoms.push({ start: s, end: e, names });
  }
  return atoms;
}

export async function extract_contract(content: string, lang: string, startLine: number, endLine: number): Promise<ContractMember[]> {
  if (!isAvailable()) return [];
  const ctx = await makeCtx(content, lang);
  if (!ctx) return [];
  const func = _anchor_func(ctx, startLine);
  if (!func) return [];
  const body = _body_of(ctx, func);

  const plist = _param_list(ctx, func);
  const sigFields = new Set<string>();
  const plainParams = new Set<string>();
  if (plist) {
    for (const p of ctx.children(plist)) {
      if (!_PARAM_NODE.has(p.type) && p.type !== "identifier") continue;
      if (ctx.collect(p, (k) => k.includes("object_pattern")).length) for (const n of _param_names(ctx, p)) sigFields.add(n);
      else for (const n of _param_names(ctx, p)) plainParams.add(n);
    }
  }
  const bodyFields = new Set<string>();
  const sources = new Set<string>();
  for (const d of ctx.collect(body, (k) => k === "variable_declarator")) {
    const ch = ctx.children(d);
    if (ch.length < 2) continue;
    const pat = ch[0], val = ch[ch.length - 1];
    if (pat.type.includes("object_pattern") && val.type === "identifier" && plainParams.has(ctx.text(val))) {
      sources.add(ctx.text(val));
      for (const f of ctx.collect(pat, (k) => k.includes("shorthand_property_identifier_pattern"))) bodyFields.add(ctx.text(f));
    }
  }
  const contract = new Set<string>([...sigFields, ...bodyFields, ...[...plainParams].filter((p) => !sources.has(p))]);
  if (!contract.size) return [];

  const idents = ctx.collect(body, (k) => k.includes("identifier"));
  const called = new Set<string>();
  for (const c of ctx.collect(body, (k) => _CALL.has(k))) {
    const ch = ctx.children(c);
    if (ch.length && ch[0].type.includes("identifier")) called.add(ctx.text(ch[0]));
  }
  const members: ContractMember[] = [];
  for (const name of [...contract].sort()) {
    const occ = idents.filter((i) => ctx.text(i) === name).map((i) => ctx.span(i)[0]);
    if (!occ.length) continue;
    members.push({ name, invoked: called.has(name), ranges: _merge_lines(occ) });
  }
  return members;
}

export async function extract_consumer_feeds(content: string, lang: string, anchorName: string): Promise<Record<string, any[]>> {
  if (!isAvailable()) return {};
  const ctx = await makeCtx(content, lang);
  if (!ctx) return {};
  const feeds: Record<string, any[]> = {};
  const elements = ctx.collect(ctx.root, (k) => k === "jsx_opening_element" || k === "jsx_self_closing_element");
  for (const el of elements) {
    const tag = ctx.children(el).find((c) => ["identifier", "member_expression", "nested_identifier"].includes(c.type));
    if (!tag || ctx.text(tag) !== anchorName) continue;
    for (const attr of ctx.children(el).filter((c) => c.type === "jsx_attribute")) {
      const ch = ctx.children(attr);
      const pnameNode = ch.find((c) => c.type.includes("property_identifier") || c.type === "identifier");
      if (!pnameNode) continue;
      const pname = ctx.text(pnameNode);
      const valnode = ch.find((c) => c.type === "jsx_expression" || c.type === "string");
      let vnode: any = null, value: string;
      if (!valnode) value = "true";
      else if (valnode.type === "jsx_expression") {
        const inner = ctx.children(valnode).filter((c) => c.isNamed);
        vnode = inner.length ? inner[0] : valnode;
        value = ctx.text(vnode);
      } else { vnode = valnode; value = ctx.text(valnode); }
      const feed: any = { value: value.trim(), line: ctx.span(attr)[0] };
      if (vnode) { feed.valLine = ctx.span(vnode)[0]; feed.valCol = ctx.col(vnode.startIndex); }
      (feeds[pname] ??= []).push(feed);
    }
  }
  return feeds;
}
