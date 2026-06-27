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
import { makeCtx, available, lang_for, _CALL, _NEW, _CLASS_KINDS, _FUNCLIKE, _VAR_DECLARATOR, _NAME_KINDS, type Ctx } from "../atoms.js";
import { makeMaskCtx } from "./adapters/util.js";
import { validateMatcher, type KeyMatcher } from "./key_ir.js";
import { HTTP_ROUTE_META } from "./adapters/http_route.js";

// The HTTP-method verbs a client is called with — `client.get('/route')`. So an inferred client's literal-route
// call sites emit an http-route CONSUME key (the route grounds to the backend handler, like any fetch caller).
const _HTTP_VERBS = ["get", "post", "put", "delete", "patch", "head", "options", "request"];

// Grounded HTTP I/O sinks — concrete browser/runtime primitives + the ubiquitous client libs. A closed set of
// REAL boundaries, not a verb heuristic. (Extend per kind when the slice generalises to store/file/db.)
const _HTTP_SINK_RE = /(?<![\w$.])(?:fetch|axios|XMLHttpRequest|ky|got)(?![\w$])/;
const _lineSet = (text: string, re: RegExp): Set<number> => {
  const out = new Set<number>(); const g = new RegExp(re.source, "g"); let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) out.add(text.slice(0, m.index).split("\n").length - 1);
  return out;
};

// The named bindings in a parse, as [name, startLine, endLine] — `const X = …`, `class X`, `function X`, and
// an assignment to an object/identifier (`X.y = …`, `module.exports = …`). The name is the receiver token a
// later call site uses; the span is what we test a sink-line for containment against.
function _bindings(ctx: Ctx): { name: string; s: number; e: number }[] {
  const out: { name: string; s: number; e: number }[] = [];
  const add = (n: any, name: string | null) => { if (name) { const [s, e] = ctx.span(n); out.push({ name, s, e }); } };
  for (const n of ctx.collect(ctx.root, (k) => _VAR_DECLARATOR.has(k) || _CLASS_KINDS.has(k) || _FUNCLIKE.has(k))) {
    const nf = n.childForFieldName?.("name");
    if (nf) add(n, ctx.text(nf));
    else { const id = ctx.children(n).find((c: any) => _NAME_KINDS.has(c.type)); if (id) add(n, ctx.text(id)); }
  }
  // assignment to an object/value: `X = …` / `X.y = …` — the LHS (dotted) is the binding name.
  for (const n of ctx.collect(ctx.root, (k) => k === "assignment_expression")) {
    const lhs = ctx.children(n)[0];
    if (lhs && (_NAME_KINDS.has(lhs.type) || lhs.type === "member_expression")) add(n, ctx.text(lhs).replace(/\s/g, ""));
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
    const sinkLines = _lineSet(code, _HTTP_SINK_RE);
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

// Channel http-route matchers for the inferred custom clients — so a `<client>.<verb>('/route')` call emits an
// http-route CONSUME key, exactly like a built-in fetch/axios caller (the route then grounds to the backend
// handler). Deterministic; no LLM, no persistence (cheap to re-derive per grow). Detection only: the route KEY
// still resolves via the literal arg here / the endpoint-map adapter / a scoped LLM for the indirected shape.
export async function inferHttpClientMatchers(files: { rel: string; text: string }[]): Promise<KeyMatcher[]> {
  const clients = await inferHttpClients(files);
  const out: KeyMatcher[] = [];
  for (const token of clients) {
    const m = validateMatcher({ via: "channel", token, verbs: _HTTP_VERBS, kind: HTTP_ROUTE_META.kind, role: "consumes" });
    if (m) out.push(m);
  }
  return out;
}
