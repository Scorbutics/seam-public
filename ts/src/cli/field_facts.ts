// AST field-level extraction for the review-impact relevance floor (MOAT.md Gap 1). The floor was
// JS/TS regex; this makes the written/read field sets AST-grounded and CROSS-LANGUAGE — JS/TS/Java/Ruby/
// C/C++ — via the shared tree-sitter `atoms` vocabulary (member access, assignment, object/hash, string,
// call), so the hero case (a JS `$http` change ↔ a Java `@GetMapping` reader) resolves fields on BOTH
// sides. Returns null when no grammar/parse is available so the caller falls back to the regex floor.
//
// Discipline (recall-safe, per the floor): `irrelevant` requires both sides pinned AND disjoint. Any
// uncertainty — dynamic/computed access, spread, serialize, an accessor we can't resolve — yields
// wholeObject/empty → `unknown`, NEVER a false `irrelevant` (which would suppress a real impact).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getParser, langForExt, field } from "../core/treesitter.js";
import { Ctx, _MEMBER, _MEMBER_NAME, _CALL, _NAME_KINDS, _OBJECT_KINDS, _PAIR_KINDS, _SHORTHAND_KEY,
  _STRING_KINDS, _SPREAD_KINDS, _ASSIGN_KINDS, _VAR_DECLARATOR } from "../codebase/atoms.js";

// WRITE verbs whose object/hash-literal arg keys are the written contract (mirrors the data-coupling
// floor, coupling/adapters/db_table.ts WRITE_VERBS, plus the generic builder verbs).
const WRITE_VERBS = new Set(["insert", "update", "upsert", "set", "create", "save", "put", "merge"]);
// Reads that consume the WHOLE object → irrelevance is unprovable.
const SERIALIZE = /^(stringify|keys|values|entries|assign|toJSON|to_json|to_h|as_json|toMap|serialize)$/;

const _ext = (file: string) => { const d = file.lastIndexOf("."); return d >= 0 ? file.slice(d).toLowerCase() : ""; };

async function ctxFor(repo: string, file: string): Promise<Ctx | null> {
  const grammar = langForExt(_ext(file));
  if (!grammar) return null;
  const parser = await getParser(grammar);
  if (!parser) return null;
  let content: string;
  try { content = readFileSync(join(repo, file), "utf-8"); } catch { return null; }
  try { return new Ctx(content, parser.parse(content).rootNode); } catch { return null; }
}

// The field name of a member-access node (`a.b` → b, `p->fee` → fee): its LAST name-like child.
function memberName(ctx: Ctx, node: any): string | null {
  let name: string | null = null;
  for (const c of ctx.children(node)) if (_MEMBER_NAME.has(c.type) || _NAME_KINDS.has(c.type)) name = ctx.text(c);
  return name;
}
// JavaBean / accessor convention: getFoo()/get_foo → foo (read), setFoo()/set_foo → foo (write). Returns
// the field for any get/set accessor (the caller checks the get/set direction).
function beanField(name: string | null): string | null {
  if (!name) return null;
  let m = /^(?:get|set)([A-Z]\w*)$/.exec(name);
  if (m) return m[1][0].toLowerCase() + m[1].slice(1);
  m = /^(?:get|set)_([a-z]\w*)$/.exec(name);
  return m ? m[1] : null;
}
// the callee NAME of a call, cross-language — grammars structure calls differently: Java
// `method_invocation` has the method in a `name` field (sibling of `object`); JS/C/C++/Python put it in
// a `function` field (an identifier, or a member/attribute/field_expression); Ruby uses `method`.
// `memberNode` (when the callee is a member-access) lets the read walk EXCLUDE it (a call ≠ a field read).
function calleeOf(ctx: Ctx, call: any): { name: string | null; memberNode: any } {
  const nm = field(call, "name");                                   // Java method_invocation
  if (nm && _NAME_KINDS.has(nm.type)) return { name: ctx.text(nm), memberNode: null };
  const fn = field(call, "function") ?? field(call, "method");      // JS/C/C++/Python | Ruby
  if (fn) {
    if (_MEMBER.has(fn.type)) return { name: memberName(ctx, fn), memberNode: fn };
    if (_NAME_KINDS.has(fn.type)) return { name: ctx.text(fn), memberNode: null };
  }
  // fallback: first member/name child (covers grammars without these field names)
  const c = ctx.children(call).find((x) => _MEMBER.has(x.type) || _NAME_KINDS.has(x.type));
  if (!c) return { name: null, memberNode: null };
  return _MEMBER.has(c.type) ? { name: memberName(ctx, c), memberNode: c } : { name: ctx.text(c), memberNode: null };
}
// the string-literal values in a call's OWN argument list (not its receiver chain — so a `select("fee")`
// chained on `.from("payments")` returns ["fee"], not ["payments","fee"]). Cross-language `arguments`
// field, falling back to the first argument_list-ish child.
function callArgStrings(ctx: Ctx, call: any): string[] {
  const args = field(call, "arguments") ?? ctx.children(call).find((c) => /argument/.test(c.type));
  if (!args) return [];
  return ctx.collect(args, (k) => _STRING_KINDS.has(k))
    .map((s) => ctx.text(s).replace(/^['"`]|['"`]$/g, "")).filter(Boolean);
}
// columns named in a `select(...)` call's args; null = whole-row (`select('*')` or no pinnable column).
function selectColumns(ctx: Ctx, call: any): Set<string> | null {
  const strs = callArgStrings(ctx, call);
  if (!strs.length || strs.some((s) => s.includes("*"))) return null;
  const cols = new Set<string>();
  for (const s of strs) for (const c of s.split(",")) { const col = c.trim(); if (/^\w+$/.test(col)) cols.add(col); }
  return cols;
}
// Gap 2 — SOUND binding: read-fields scoped to the object that carries the KEY's data, i.e. the columns
// of a `select(...)` whose chain reads `.from(<key>)` (the receiver is in the select call's own subtree).
// Returns the bound fields when ≥1 such select exists, else null (caller falls back to the whole file).
// This drops the false `relevant` from an unrelated `widget.fee` elsewhere in the reader.
function keyBoundFields(ctx: Ctx, key: string): ReadFacts | null {
  let found = false; const fields = new Set<string>(); let wholeObject = false;
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    if (calleeOf(ctx, call).name !== "select") continue;
    const boundToKey = ctx.collect(call, (k) => _CALL.has(k))
      .some((c) => calleeOf(ctx, c).name === "from" && callArgStrings(ctx, c).includes(key));
    if (!boundToKey) continue;
    found = true;
    const cols = selectColumns(ctx, call);
    if (cols) for (const c of cols) fields.add(c); else wholeObject = true;
  }
  return found ? { fields, wholeObject } : null;
}
// the keys of any object/hash literal inside a call.
function objectKeys(ctx: Ctx, call: any): string[] {
  const out: string[] = [];
  for (const obj of ctx.collect(call, (k) => _OBJECT_KINDS.has(k))) {
    for (const sh of ctx.collect(obj, (k) => _SHORTHAND_KEY.has(k))) out.push(ctx.text(sh));   // { fee }
    for (const pair of ctx.collect(obj, (k) => _PAIR_KINDS.has(k))) {                          // { fee: x }
      const key = ctx.children(pair).find((c) => _NAME_KINDS.has(c.type) || _STRING_KINDS.has(c.type));
      if (key) out.push(ctx.text(key).replace(/^['"`]|['"`]$/g, ""));
    }
  }
  return out;
}

export interface ReadFacts { fields: Set<string>; wholeObject: boolean; }
const _readCache = new Map<string, ReadFacts | null>();

// READ side: the fields a consumer file reads. When a `key` (the shared table/route the cross-stack edge
// is on) is given AND the reader has a `.from(key).select(cols)` binding, scope to THOSE columns (Gap 2 —
// sound: an unrelated `widget.fee` elsewhere in the file no longer counts). Otherwise fall back to the
// whole-file scan: pure member-access reads + accessor getters + select columns. wholeObject when the file
// consumes an object opaquely (spread, serialize, `select('*')`, dynamic member) → can't PROVE irrelevant.
// null = no parse.
export async function readFieldsOf(repo: string, file: string, key?: string): Promise<ReadFacts | null> {
  const ck = `${repo}\0${file}\0${key ?? ""}`;
  const hit = _readCache.get(ck); if (hit !== undefined) return hit;
  const ctx = await ctxFor(repo, file);
  if (!ctx) { _readCache.set(ck, null); return null; }
  // Gap 2: a key-bound select is authoritative — the columns read off the key's own data.
  if (key) { const bound = keyBoundFields(ctx, key); if (bound) { _readCache.set(ck, bound); return bound; } }
  const fields = new Set<string>();
  let wholeObject = false;
  const callees = new Set<any>();   // member nodes that are call callees (a method call ≠ a field read)
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {
    const callee = calleeOf(ctx, call);
    if (callee.memberNode) callees.add(callee.memberNode);
    const name = callee.name; if (!name) continue;
    const bean = beanField(name); if (bean && /^get/.test(name)) fields.add(bean);   // getFee() → fee
    if (SERIALIZE.test(name)) wholeObject = true;
    if (name === "select") { const cols = selectColumns(ctx, call); if (cols) for (const c of cols) fields.add(c); else wholeObject = true; }
  }
  for (const m of ctx.collect(ctx.root, (k) => _MEMBER.has(k))) {
    if (callees.has(m)) continue;                          // it's the function of a call, not a field read
    const n = memberName(ctx, m); if (n) fields.add(n);
  }
  if (ctx.collect(ctx.root, (k) => _SPREAD_KINDS.has(k)).length) wholeObject = true;   // spread / dynamic member
  const res: ReadFacts = { fields, wholeObject };
  _readCache.set(ck, res);
  return res;
}

// WRITE side: the fields a change writes, restricted to the CHANGED lines of the post-image file —
// declarator/assignment LHS (member or identifier), write-call object keys, accessor setters.
// `changedLines` are 1-based new-side line numbers (from changed_newside). null = no parse. Over-
// collection here is recall-SAFE (more written fields → fewer provable-irrelevant, never a false suppress).
export async function writtenFieldsOf(repo: string, file: string, changedLines: Set<number>): Promise<Set<string> | null> {
  const ctx = await ctxFor(repo, file);
  if (!ctx) return null;
  const out = new Set<string>();
  const inChange = (n: any) => changedLines.has(ctx.ln(n.startIndex) + 1);   // Ctx.ln is 0-based; diff lines 1-based
  for (const d of ctx.collect(ctx.root, (k) => _VAR_DECLARATOR.has(k))) {    // const fee = …
    if (!inChange(d)) continue;
    const name = ctx.children(d).find((c) => _NAME_KINDS.has(c.type));
    if (name) out.add(ctx.text(name));
  }
  for (const a of ctx.collect(ctx.root, (k) => _ASSIGN_KINDS.has(k))) {      // obj.fee = … / fee = …
    if (!inChange(a)) continue;
    const lhs = ctx.children(a)[0]; if (!lhs) continue;
    if (_MEMBER.has(lhs.type)) { const n = memberName(ctx, lhs); if (n) out.add(n); }
    else if (_NAME_KINDS.has(lhs.type)) out.add(ctx.text(lhs));
  }
  for (const call of ctx.collect(ctx.root, (k) => _CALL.has(k))) {           // .insert({ fee }) / setFee(x)
    if (!inChange(call)) continue;
    const name = calleeOf(ctx, call).name; if (!name) continue;
    const bean = beanField(name); if (bean && /^set/.test(name)) out.add(bean);
    if (WRITE_VERBS.has(name)) for (const k of objectKeys(ctx, call)) out.add(k);
  }
  return out;
}
