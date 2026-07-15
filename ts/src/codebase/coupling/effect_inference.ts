// EFFECT INFERENCE (minimal slice — HTTP) — detect a CUSTOM http-client receiver TRANSITIVELY, so its call
// sites are recognised as HTTP data-coupling edges even though the receiver name isn't fetch/axios and the
// route is indirected. The chain: a grounded sink (`fetch`/`axios`) is HTTP; an in-repo binding whose body
// CALLS that sink inherits HTTP (`const httpService = { get(){ fetch(…) } }`); a binding ALIASED to it inherits
// it too (`MyFramework.http = httpService`). The result is the SET of http-client receiver tokens — fed to the
// route grounding so `MyFramework.http[method](endpoints.createBooking)` is a detected edge (the KEY/route is
// then resolved by the endpoint-map adapter or a scoped LLM; this pass only DECIDES it's an edge).
//
// Deterministic, no LLM, no keyword guessing: the seed is concrete I/O PRIMITIVES (not verbs like get/http),
// and the propagation rides real in-repo definitions/assignments (not blind call-site resolution).
import { makeCtx, available, lang_for, _CALL, _NEW, _CLASS_KINDS, _VAR_DECLARATOR, _NAME_KINDS, type Ctx } from "../atoms.js";
import { makeMaskCtx, lineOf } from "./adapters/util.js";
import { validateMatcher, type KeyMatcher } from "./key_ir.js";
import { HTTP_ROUTE_META, normPath } from "./adapters/http_route.js";
import { CONST_RE_SRC, ENDPOINT_RE_SRC, resolveExpr } from "./adapters/endpoint_map.js";
import { httpClientNames, escapeRegex } from "./frameworks/http_clients.js";
import type { KeyHit } from "./types.js";

// The HTTP-method verbs a client is called with — `client.get('/route')`. So an inferred client's literal-route
// call sites emit an http-route CONSUME key (the route grounds to the backend handler, like any fetch caller).
const _HTTP_VERBS = ["get", "post", "put", "delete", "patch", "head", "options", "request"];

// Grounded HTTP I/O sinks — the registered client names (frameworks/http_clients.ts — the SAME registry
// httpClientCallRegex() builds from, so a client added there is recognised here too, including at runtime
// via registerHttpClients — hence built fresh per call, not cached) plus `XMLHttpRequest`, the one raw
// browser primitive that doesn't fit the HttpClient call-shape (`new XMLHttpRequest()`, not a
// name(...)/name.verb(...) call) and so stays a local addition. A closed set of REAL boundaries, not a verb
// heuristic. (Extend per kind when the slice generalises to store/file/db.)
const _httpSinkRe = (): RegExp => new RegExp(`(?<![\\w$.])(?:${[...httpClientNames(), "XMLHttpRequest"].map(escapeRegex).join("|")})(?![\\w$])`);
const _lineSet = (text: string, re: RegExp): Set<number> => {
  const out = new Set<number>(); const g = new RegExp(re.source, "g"); let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) out.add(text.slice(0, m.index).split("\n").length - 1);
  return out;
};

// Object-literal node kinds — the VALUE shape that makes a binding a client CANDIDATE (a receiver you call
// verb-methods on: `client.get('/route')`), as opposed to a plain function that merely CALLS a sink.
const _OBJECT_KINDS = new Set(["object", "object_expression"]);
const _valueIsObjOrClass = (ctx: Ctx, n: any): boolean =>
  ctx.children(n).some((c: any) => _OBJECT_KINDS.has(c.type) || _CLASS_KINDS.has(c.type));

// The named CLIENT-CANDIDATE bindings in a parse, as [name, startLine, endLine]: a binding whose VALUE is an
// OBJECT or CLASS (`const httpService = { get(){…} }`, `class Api {…}`), which a sink inside one of its methods
// makes an http client. A plain `function X(){ fetch() }` / `const res = fetch()` is a fetch-CALLER, not a
// reusable client receiver (you never call `X.get('/route')` / `res.get(…)`) — so it is NOT a candidate, and
// marking it was the over-inference that minted thousands of phantom clients on a big repo. Aliases (`X.y =
// httpService`) still inherit via _ALIAS_RE below. The span is what a sink-line is tested against.
function _bindings(ctx: Ctx): { name: string; s: number; e: number }[] {
  const out: { name: string; s: number; e: number }[] = [];
  const add = (n: any, name: string | null) => { if (name) { const [s, e] = ctx.span(n); out.push({ name, s, e }); } };
  for (const n of ctx.collect(ctx.root, (k) => _VAR_DECLARATOR.has(k) || _CLASS_KINDS.has(k))) {
    if (_VAR_DECLARATOR.has(n.type) && !_valueIsObjOrClass(ctx, n)) continue;   // a function/value wrapper is a CALLER, not a client
    const nf = n.childForFieldName?.("name");
    if (nf) add(n, ctx.text(nf));
    else { const id = ctx.children(n).find((c: any) => _NAME_KINDS.has(c.type)); if (id) add(n, ctx.text(id)); }
  }
  // assignment whose RHS is an object/class: `X = { … }` / `X.y = class …` — the LHS (dotted) is the client name.
  for (const n of ctx.collect(ctx.root, (k) => k === "assignment_expression")) {
    const lhs = ctx.children(n)[0];
    if (lhs && (_NAME_KINDS.has(lhs.type) || lhs.type === "member_expression") && _valueIsObjOrClass(ctx, n))
      add(n, ctx.text(lhs).replace(/\s/g, ""));
  }
  return out;
}

// `X = Y` / `const X = Y` / `X.y = Y` where Y is a BARE identifier — an alias edge (X inherits Y's effect).
const _ALIAS_RE = /(?:^|[\s;{(])(?:(?:const|let|var)[ \t]+)?([A-Za-z_$][\w$.]*)[ \t]*=[ \t]*([A-Za-z_$][\w$]*)[ \t]*[;\n]/g;

// Infer the set of http-client receiver TOKENS across the given files (footprint-scoped by the caller). A token
// is a single identifier (`httpService`) or a dotted receiver path (`MyFramework.http`). Pure → unit-testable.
export async function inferHttpClients(files: { rel: string; text: string }[]): Promise<Set<string>> {
  if (!available()) return new Set();
  const httpEffect = new Set<string>();
  const aliases: [string, string][] = [];   // [lhs, rhs] — lhs inherits rhs's effect
  for (const { rel, text } of files) {
    const lang = lang_for(rel);
    if (!lang) continue;
    const code = makeMaskCtx(text).comments;            // sink/alias scan on comment-masked code
    const sinkLines = _lineSet(code, _httpSinkRe());
    if (sinkLines.size) {
      const ctx = await makeCtx(code, lang);
      if (ctx) for (const b of _bindings(ctx)) if ([...sinkLines].some((l) => l >= b.s && l <= b.e)) httpEffect.add(b.name);
    }
    let m: RegExpExecArray | null; _ALIAS_RE.lastIndex = 0;
    while ((m = _ALIAS_RE.exec(code)) !== null) aliases.push([m[1].replace(/\s/g, ""), m[2]]);
  }
  // propagate the http effect across aliases to a fixpoint (X = httpService → X is http; bounded by |aliases|).
  for (let changed = true; changed; ) {
    changed = false;
    for (const [lhs, rhs] of aliases) if (httpEffect.has(rhs) && !httpEffect.has(lhs)) { httpEffect.add(lhs); changed = true; }
  }
  return httpEffect;
}

// Channel http-route matchers for a set of custom clients — so a `<client>.<verb>('/route')` call emits an
// http-route CONSUME key, exactly like a built-in fetch/axios caller (the route then grounds to the backend
// handler). Deterministic; no LLM, no persistence (cheap to re-derive per grow). Handles the LITERAL-route arg;
// the INDIRECTED arg (`<client>[method](endpoints.createBooking)`) is resolved by resolveHttpCallSites below.
export function httpClientMatchers(clients: Set<string>): KeyMatcher[] {
  const out: KeyMatcher[] = [];
  for (const token of clients) {
    const m = validateMatcher({ via: "channel", token, verbs: _HTTP_VERBS, kind: HTTP_ROUTE_META.kind, role: "consumes" });
    if (m) out.push(m);
  }
  return out;
}
export async function inferHttpClientMatchers(files: { rel: string; text: string }[]): Promise<KeyMatcher[]> {
  return httpClientMatchers(await inferHttpClients(files));
}

// ── INDIRECTED route resolution — the "resolve the route on a proven edge" half ──────────────────────────────
// A declarative client calls its custom http client with a DESCRIPTOR ref, not a literal: a dynamic verb AND a
// config reference — `MyFramework.http[method]( bookingEndpoints.createBooking, state )`. The channel matcher
// (which wants `.verb('/literal')`) can't see this. But the EDGE is already proven (the receiver is an inferred
// http client) and the ROUTE is GROUNDED data (the `{ endpoint, method }` config map in the same module). So we
// resolve the descriptor against that map — no LLM, no blind call resolution, no keyword guessing.

// `<mapVar>.<key>` → its resolved endpoint route, from the file's `const <mapVar> = { <key>: { endpoint: … } }`
// descriptor maps (brace-balanced so a nested object doesn't truncate). Reuses the endpoint-map adapter's const
// resolution + endpoint regex — same route extraction, keyed by the map.key a call site references.
const _balancedFrom = (s: string, open: number): string | null => {   // s[open] === '{' → the inner text
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(open + 1, i);
  }
  return null;
};
function _endpointMapIndex(src: string): Map<string, string> {
  const consts = new Map<string, string>();
  const cre = new RegExp(CONST_RE_SRC, "g"); let cm: RegExpExecArray | null;
  while ((cm = cre.exec(src))) if (!consts.has(cm[1])) consts.set(cm[1], cm[2]);
  const out = new Map<string, string>();
  const decl = /(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*\{/g; let dm: RegExpExecArray | null;
  while ((dm = decl.exec(src)) !== null) {
    const body = _balancedFrom(src, dm.index + dm[0].length - 1);
    if (!body) continue;
    const entry = /(['"]?)([A-Za-z_$][\w$]*)\1[ \t]*:[ \t]*\{/g; let em: RegExpExecArray | null;
    while ((em = entry.exec(body)) !== null) {
      const entBody = _balancedFrom(body, em.index + em[0].length - 1);
      if (!entBody) continue;
      const e2 = new RegExp(ENDPOINT_RE_SRC, "g").exec(entBody);
      if (!e2) continue;
      const route = resolveExpr(e2[1], consts);
      if (route && route.startsWith("/")) out.set(`${dm[1]}.${em[2]}`, normPath(route));
    }
  }
  return out;
}

const _STR_LIT_RE = /^['"`]([^'"`]*)['"`]$/;
// HTTP-route CONSUME keys for a file's calls to an inferred http client, resolving the FIRST argument to a route:
// a string literal directly, or a `<map>.<key>`/`<map>.<key>.endpoint` descriptor ref against the in-file config.
// Surfaced at the CALL line (so the calling method node owns the crossing), complementing the channel matcher's
// literal path. An opaque arg (neither literal nor a known descriptor) is left unresolved — a scoped-LLM job,
// out of this deterministic slice. Pure → unit-testable on the fixture.
export function resolveHttpCallSites(file: string, text: string, clients: Set<string>): KeyHit[] {
  if (!clients.size || !lang_for(file)) return [];
  const src = makeMaskCtx(text).comments;
  const cfg = _endpointMapIndex(src);
  // Resolve an EXPRESSION to a route: a string literal, or a descriptor ref (`map.key` / `map.key.endpoint`,
  // possibly chained with `.replace(...)`) against the in-file endpoint map. The leading dotted path is taken and
  // cut at `.endpoint`, so `bookingEndpoints.cancelBooking.endpoint.replace('{id}', id)` → `bookingEndpoints.cancelBooking`.
  const _descRoute = (expr: string): string | null => {
    const lit = expr.match(_STR_LIT_RE);
    if (lit) return lit[1].startsWith("/") ? normPath(lit[1]) : null;
    const dotted = expr.match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/);
    if (!dotted) return null;
    let p = dotted[0]; const ei = p.indexOf(".endpoint");
    if (ei >= 0) p = p.slice(0, ei);
    return cfg.get(p) ?? null;
  };
  const out: KeyHit[] = [];
  const seen = new Set<string>();
  for (const client of clients) {
    const esc = client.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // `<client>.verb( ARG` OR `<client>[verb]( ARG` — dynamic verb included; ARG = the first arg up to , or ).
    const re = new RegExp(`(?<![\\w$.])${esc}[ \\t]*(?:\\.[ \\t]*[A-Za-z_$]\\w*|\\[[^\\]]+\\])[ \\t]*\\([ \\t]*([^,)]+)`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const arg = m[1].trim();
      let route = _descRoute(arg);
      // ARG is a BARE LOCAL VAR (the declarative pattern: `const endpoint = bookingEndpoints.cancelBooking.endpoint
      // .replace('{id}', id); http[method](endpoint)`) — trace it to its NEAREST PRECEDING assignment and resolve
      // THAT descriptor, so each method's specific route (not just the base) is attributed to its own call site.
      if (!route && /^[A-Za-z_$][\w$]*$/.test(arg)) {
        const asnRe = new RegExp(`(?:const|let|var)[ \\t]+${arg}[ \\t]*=[ \\t]*(.+)`, "g");
        const before = src.slice(0, m.index); let a: RegExpExecArray | null, rhs: string | null = null;
        while ((a = asnRe.exec(before)) !== null) rhs = a[1];   // last assignment before the call = the in-scope one
        if (rhs) route = _descRoute(rhs.trim());
      }
      if (!route || route === "/") continue;
      const line = lineOf(src, m.index);
      const id = `${route}@${line}`;
      if (seen.has(id)) continue; seen.add(id);
      out.push({ kind: HTTP_ROUTE_META.kind, value: route, line, produces: false });
    }
  }
  return out;
}
