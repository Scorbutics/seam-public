// Port of src/diff/facts.py — the universal HunkFacts IR + the regex producer & provider strategy.
import type { Hunk } from "./parser.js";
import { _added, _CALL_ROOT, _defs_refs, _IDENT, _JSX_TAG } from "./lang.js";
import { findAll, findGroup1, sorted } from "../core/sets.js";

export const FACTS_SCHEMA_VERSION = 1;

// Python `raw[:1] in "+- "` / `raw[1:]` semantics — note `"+- ".includes("")` is true
// (empty string is a substring), so an empty line strips to "" with marker "" (matching Python).
function _markerOf(line: string): string {
  const m = line.slice(0, 1);
  return "+- ".includes(m) ? m : "";
}
function _stripMarker(line: string): string {
  return "+- ".includes(line.slice(0, 1)) ? line.slice(1) : line;
}

// --- language surface patterns ----------------------------------------------
const _LOGIC = /\b(if|else|for|while|switch|case|return|throw|try|catch|await|yield)\b|&&|\|\||[!=<>]=|\?\./;
const _IMPORT_LINE = /^\s*(import\b|export\b.*\bfrom\b|from\b.+\bimport\b|export\s*\{)/;
const _TYPE_DECL = /\b(interface|type|enum)\s+[A-Za-z_]/;
const _CODE_DEF = /\b(function|class|def|fun)\b|=>/;
const _TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|[._/](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|ts|js)$|_spec\.rb$|test[a-z0-9_]*\.(kt|java)$/i;
const _TEST_MARKER = /\b(describe|it|expect|test)\s*\(|@Test\b|\bself\.assert|\bunittest\b|\bpytest\b/;
const _IMPLEMENTS = /\bimplements\s+([A-Z]\w*)/g;
const _DIRECTIVE = /^\s*["'](?:use [a-z]+)["'];?\s*$/;

function _is_ambient_line(stripped: string): boolean {
  const s = stripped.trim();
  if (!s || s.startsWith("//") || s.startsWith("#") || s.startsWith("/*") || s.startsWith("*") || s.startsWith("*/"))
    return true;
  if (_DIRECTIVE.test(s) || _IMPORT_LINE.test(s)) return true;
  return _TYPE_DECL.test(s) && !_CODE_DEF.test(s) && !_LOGIC.test(s);
}

export function leading_ambient_lines(hunk: Hunk): number {
  const body = hunk.text.split("\n").slice(1);
  let k = 0;
  let saw_anchor = false;
  for (const raw of body) {
    const stripped = _stripMarker(raw);
    if (!_is_ambient_line(stripped)) break;
    k += 1;
    const s = stripped.trim();
    if (s && !(s.startsWith("//") || s.startsWith("#") || s.startsWith("/*") || s.startsWith("*") || s.startsWith("*/")))
      saw_anchor = true;
  }
  if (!saw_anchor || k === 0 || k >= body.length) return 0;
  return k;
}

export interface HunkFacts {
  defines: Set<string>;
  references: Set<string>;
  calls: Set<string>;
  enclosing: Set<string>;
  decisions: number;
  implements: Set<string>;
  is_test: boolean;
  is_sql: boolean;
  imports_only: boolean;
  type_decl_only: boolean;
  resolved_refs: Record<string, string>;
}

export function mkFacts(p: Partial<HunkFacts> = {}): HunkFacts {
  return {
    defines: p.defines ?? new Set(), references: p.references ?? new Set(),
    calls: p.calls ?? new Set(), enclosing: p.enclosing ?? new Set(),
    decisions: p.decisions ?? 0, implements: p.implements ?? new Set(),
    is_test: p.is_test ?? false, is_sql: p.is_sql ?? false,
    imports_only: p.imports_only ?? false, type_decl_only: p.type_decl_only ?? false,
    resolved_refs: p.resolved_refs ?? {},
  };
}

export function factsToDict(f: HunkFacts): Record<string, unknown> {
  return {
    defines: sorted(f.defines), references: sorted(f.references), calls: sorted(f.calls),
    enclosing: sorted(f.enclosing), decisions: f.decisions, implements: sorted(f.implements),
    is_test: f.is_test, is_sql: f.is_sql, imports_only: f.imports_only,
    type_decl_only: f.type_decl_only,
    resolved_refs: Object.fromEntries(Object.entries(f.resolved_refs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

export function factsFromDict(d: any): HunkFacts {
  return mkFacts({
    defines: new Set(d.defines ?? []), references: new Set(d.references ?? []),
    calls: new Set(d.calls ?? []), enclosing: new Set(d.enclosing ?? []),
    decisions: Number(d.decisions ?? 0), implements: new Set(d.implements ?? []),
    is_test: Boolean(d.is_test ?? false), is_sql: Boolean(d.is_sql ?? false),
    imports_only: Boolean(d.imports_only ?? false), type_decl_only: Boolean(d.type_decl_only ?? false),
    resolved_refs: { ...(d.resolved_refs ?? {}) },
  });
}

function setEq<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export function factsEqual(a: HunkFacts, b: HunkFacts): boolean {
  return setEq(a.defines, b.defines) && setEq(a.references, b.references)
    && setEq(a.calls, b.calls) && setEq(a.enclosing, b.enclosing)
    && a.decisions === b.decisions && setEq(a.implements, b.implements)
    && a.is_test === b.is_test && a.is_sql === b.is_sql
    && a.imports_only === b.imports_only && a.type_decl_only === b.type_decl_only
    && JSON.stringify(a.resolved_refs) === JSON.stringify(b.resolved_refs);
}

// --- comment/string masking (stateful scanner, not a lexer) ------------------
function _mask_code(text: string): string {
  const outLines: string[] = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const marker = _markerOf(raw);
    const s = raw.slice(marker.length);
    const masked: string[] = [];
    let i = 0;
    const n = s.length;
    let inStr: string | null = null;
    while (i < n) {
      const c = s[i];
      const two = s.slice(i, i + 2);
      if (inBlock) {
        if (two === "*/") { inBlock = false; i += 2; continue; }
        i += 1; continue;
      }
      if (inStr) {
        if (c === "\\") { i += 2; continue; }
        masked.push(c === inStr ? c : " ");
        if (c === inStr) inStr = null;
        i += 1; continue;
      }
      if (two === "/*") { inBlock = true; i += 2; continue; }
      if (two === "//") break;
      if (c === '"' || c === "'" || c === "`") { inStr = c; masked.push(c); i += 1; continue; }
      masked.push(c); i += 1;
    }
    outLines.push(marker + masked.join(""));
  }
  return outLines.join("\n");
}

function _substantive_lines(added: string): string[] {
  const out: string[] = [];
  for (const raw of added.split("\n")) {
    const s = raw.trim();
    if (!s || s.startsWith("//") || s.startsWith("#") || s.startsWith("/*") || s.startsWith("*") || s.startsWith("*/"))
      continue;
    if ([...s].every((c) => "{}()[];,".includes(c))) continue;
    out.push(s);
  }
  return out;
}

function _body_lines(text: string): string[] {
  return text.split("\n").slice(1).map(_stripMarker);
}

export function facts_from_texts(
  raw_text: string, masked_text: string, file_path: string, section_header: string,
): HunkFacts {
  const m_added = _added(masked_text);
  const m_sub = _substantive_lines(m_added);
  const m_body = _body_lines(masked_text);

  const decisions = m_sub.filter((ln) => _LOGIC.test(ln)).length;
  const imports_only = m_sub.length > 0 && m_sub.every((ln) => _IMPORT_LINE.test(ln));
  const type_decl_only = m_sub.length > 0 && decisions === 0
    && _TYPE_DECL.test(m_added) && !_CODE_DEF.test(m_added);
  const is_test = _TEST_PATH.test(file_path || "")
    || (_TEST_MARKER.test(m_added) && !_CODE_DEF.test(m_added));
  const impls = new Set(findGroup1(_IMPLEMENTS, m_body.join("\n")));

  const [defines, references] = _defs_refs(raw_text);
  const calls = new Set<string>();
  for (const ln of _body_lines(raw_text)) {
    for (const m of findGroup1(_CALL_ROOT, ln)) calls.add(m);
    for (const m of findGroup1(_JSX_TAG, ln)) calls.add(m);
  }
  const enclosing = new Set(findAll(_IDENT, section_header || ""));

  return mkFacts({
    defines, references, calls, enclosing, decisions, implements: impls,
    is_test, is_sql: (file_path || "").endsWith(".sql"),
    imports_only, type_decl_only,
  });
}

export function extract(h: Hunk): HunkFacts {
  return facts_from_texts(h.text, _mask_code(h.text), h.file_path, h.section_header);
}

// --- providers ---------------------------------------------------------------
export interface FactsProvider {
  facts(hunks: Hunk[]): Map<string, HunkFacts>;
}

export class RegexFactsProvider implements FactsProvider {
  facts(hunks: Hunk[]): Map<string, HunkFacts> {
    const out = new Map<string, HunkFacts>();
    for (const h of hunks) out.set(h.id, extract(h));
    return out;
  }
}

export class ExternalFactsProvider implements FactsProvider {
  private byId: Record<string, any>;
  private fallback: FactsProvider;
  constructor(payload: any, fallback?: FactsProvider) {
    this.byId = (payload ?? {}).hunks ?? {};
    this.fallback = fallback ?? new RegexFactsProvider();
  }
  facts(hunks: Hunk[]): Map<string, HunkFacts> {
    const out = new Map<string, HunkFacts>();
    const missing: Hunk[] = [];
    for (const h of hunks) {
      const d = this.byId[h.id];
      if (d === undefined) missing.push(h);
      else out.set(h.id, factsFromDict(d));
    }
    if (missing.length) for (const [k, v] of this.fallback.facts(missing)) out.set(k, v);
    return out;
  }
}

export class MergedFactsProvider implements FactsProvider {
  private static SET_FIELDS = new Set(["defines", "references", "calls", "enclosing", "implements"]);
  private static BOOL_FIELDS = new Set(["is_test", "is_sql", "imports_only", "type_decl_only"]);
  private base: FactsProvider;
  private fields: string[];
  private byId: Record<string, any>;
  constructor(base: FactsProvider, payload: any) {
    this.base = base;
    this.fields = [...((payload ?? {}).fields ?? [])];
    this.byId = (payload ?? {}).hunks ?? {};
  }
  facts(hunks: Hunk[]): Map<string, HunkFacts> {
    const out = this.base.facts(hunks);
    for (const h of hunks) {
      const ov = this.byId[h.id];
      const hf = out.get(h.id);
      if (!ov || !hf) continue;
      for (const f of this.fields) {
        if (!(f in ov)) continue;
        if (MergedFactsProvider.SET_FIELDS.has(f)) (hf as any)[f] = new Set(ov[f]);
        else if (f === "decisions") hf.decisions = Number(ov[f]);
        else if (MergedFactsProvider.BOOL_FIELDS.has(f)) (hf as any)[f] = Boolean(ov[f]);
      }
    }
    return out;
  }
}

export function facts_payload(hunks: Hunk[], provider?: FactsProvider): Record<string, unknown> {
  provider = provider ?? new RegexFactsProvider();
  const f = provider.facts(hunks);
  const hunksObj: Record<string, unknown> = {};
  for (const [hid, hf] of f) hunksObj[hid] = factsToDict(hf);
  return { version: FACTS_SCHEMA_VERSION, hunks: hunksObj };
}
