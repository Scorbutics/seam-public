// CONSTRAINED KEY-ADAPTER IR — the executable form of a LEARNED shared-key adapter. Where the per-file
// LLM key index (llm_key_index.ts) emits literal keys for ONE file, a KeyMatcher is a reusable RULE the
// LLM synthesizes once and the engine then runs DETERMINISTICALLY over every file, forever (cached to
// `.seam/`). This is the "LLM picks the SHAPE, the engine EXECUTES it" split: the model never writes a
// regex (a ReDoS / correctness hazard run repo-wide) — it fills a small, closed structural template, and a
// safe matcher does the scanning. Today the supported shape is a CALL with a string-literal key argument
// (`$emit('sync')`, `publish('topic')`, `cache.get('k')`, `from('table')`) — the dominant key-carrying
// shape across frameworks; template/attribute shapes stay the hand-written adapters' job (e.g. event_binding).
import type { KeyHit } from "./types.js";
import { lineOf, maskComments } from "./adapters/util.js";

// LLM free-text kind vocab → registered adapter kinds (mirrors llm_key_index._KIND_ALIASES so a learned
// matcher's kind lands on the SAME boundary node + edge kinds as the deterministic floor).
const _KIND_ALIASES: Record<string, string> = { route: "http-route", endpoint: "http-route", http: "http-route", url: "http-route", path: "http-route" };
const _canonKind = (k: string): string => { const t = k.toLowerCase().trim(); return _KIND_ALIASES[t] ?? (t || "key"); };

// One learned, executable detection rule. `token` is a bare identifier (validated — no regex metachars),
// so the executor builds a SAFE anchored pattern from it. `name`/`description` keep `.seam/` human-reviewable.
export interface KeyMatcher {
  via: "call";                        // structural shape (only call-with-literal-arg executes today)
  token: string;                      // the callee identifier, e.g. "$emit" / "publish" / "from"
  argIndex: number;                   // 0-based index of the string-literal argument that IS the key
  kind: string;                       // canonical key kind (db-table|queue|event|route|cache|key)
  role: "produces" | "consumes";      // does this call WRITE/EMIT the key, or READ/HANDLE it
  name?: string;
  description?: string;
}

const _TOKEN_OK = /^[A-Za-z_$][\w$]*$/;   // a single identifier (member chains/metachars rejected → safe to embed)
const _slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

// Validate ONE LLM object → a KeyMatcher, or null (malformed / unsupported shape). The gate that keeps a
// free-text model answer from becoming an executable rule unless it fits the closed template exactly.
export function validateMatcher(obj: any): KeyMatcher | null {
  if (!obj || typeof obj !== "object") return null;
  if (String(obj.via ?? "call").toLowerCase() !== "call") return null;     // only the call shape executes today
  const token = String(obj.token ?? "").trim();
  if (!_TOKEN_OK.test(token)) return null;                                  // not a bare identifier → reject (no regex injection)
  const argIndex = Number.isInteger(obj.argIndex) && obj.argIndex >= 0 ? obj.argIndex : 0;
  const role: "produces" | "consumes" = String(obj.role ?? "").toLowerCase().startsWith("produc") ? "produces" : "consumes";
  const kind = _canonKind(String(obj.kind ?? "key"));
  const name = _slug(String(obj.name ?? "")) || `${_slug(token)}-${kind}`;
  const description = String(obj.description ?? "").trim().slice(0, 200) || `${role} ${kind} via ${token}(arg ${argIndex})`;
  return { via: "call", token, argIndex, kind, role, name, description };
}

// The content of the `n`-th (0-based) call argument IF it is a pure string literal, else null. `start` is
// the index JUST AFTER the opening `(`. Tracks nesting + string state so commas inside nested calls/objects
// or strings don't split args; a concatenated/computed arg (`'a' + x`) returns null (it can't ground anyway).
function nthStringArg(text: string, start: number, n: number): string | null {
  const lit = (raw: string): string | null => {
    const s = raw.trim();
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === "`") && s[s.length - 1] === s[0]) {
      const inner = s.slice(1, -1);
      return /[`'"]/.test(inner) ? null : inner;   // a nested quote ⇒ concatenation/template ⇒ not a clean literal
    }
    return null;
  };
  let depth = 0, arg = 0, argStart = start, i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {                              // skip a string literal whole
      const q = c; i++;
      while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; i++; }
      i++; continue;
    }
    if (c === "(" || c === "[" || c === "{") { depth++; i++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return arg === n ? lit(text.slice(argStart, i)) : null;   // end of the call's args
      depth--; i++; continue;
    }
    if (c === "," && depth === 0) {
      if (arg === n) return lit(text.slice(argStart, i));
      arg++; argStart = i + 1; i++; continue;
    }
    i++;
  }
  return null;
}

// Execute a matcher over a file's text → the keys it detects. Deterministic, bounded, no LLM. The anchored
// pattern `(?<![\w$])token(` keeps `token` from matching inside a larger identifier; member forms
// (`this.$emit`, `cache.get`) still match because `.` is allowed immediately before the token.
export function runMatcher(m: KeyMatcher, text: string): KeyHit[] {
  const masked = maskComments(text);   // a call inside a comment is not a real access
  const esc = m.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w$])${esc}\\s*\\(`, "g");
  const out: KeyHit[] = [];
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(masked)) !== null) {
    const value = nthStringArg(masked, re.lastIndex, m.argIndex);
    if (value) out.push({ kind: m.kind, value, line: lineOf(masked, mt.index), produces: m.role === "produces" });
  }
  return out;
}
