// DECLARATIVE ENDPOINT-MAP adapter — the CONSUMER side of an HTTP route declared as DATA, not at a call-site.
// A config-driven API client lists its operations as `{ endpoint: <route>, method: <verb> }` descriptors and
// fires them through a GENERIC wrapper (`Vue.http[cfg.method](cfg.endpoint, …)`), so the route literal lives in
// the config object, never at a `$http.post("/literal")` call — invisible to the http_route adapter (which
// scans call-sites). This reads the descriptor: the `endpoint`/`url`/`path` value (resolving a `baseUrl + '/x'`
// concatenation against same-file const string decls) becomes an http-route CONSUME key, so it grounds to the
// server `@Path` handler exactly like a fetch caller. Same `http-route` kind → same boundary + crossing.
import { HTTP_ROUTE_META, normPath } from "./http_route.js";
import { lineOf, maskComments } from "./util.js";
import type { KeyHit, KeyKind, MaskCtx } from "../types.js";

const _CLIENT_EXT = /\.(?:m|c)?[jt]sx?$|\.vue$/;
// A const STRING declaration — `const baseUrl = '/acme/rest/member/booking/v1'` — for resolving an endpoint that
// concatenates a base (`baseUrl + '/{id}'`). Same-file scope only (the common case); unresolved → skipped.
// Exported as a SOURCE string (not a compiled /g RegExp) so reusers compile their own stateless instance — the
// indirected effect-inference call-site resolver builds the same const map without sharing this one's lastIndex.
export const CONST_RE_SRC = "(?:const|let|var)[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*=[ \\t]*['\"`]([^'\"`\\n]+)['\"`]";
const _CONST_RE = new RegExp(CONST_RE_SRC, "g");
// A concatenation TOKEN: an identifier/member (`baseUrl`) OR a string literal (which may contain `{id}` — the
// quoted sub-pattern consumes the braces, so a route template doesn't truncate the match the way `[^}]*` did).
const _TOKEN = `(?:[A-Za-z_$][\\w$.]*|['"\`][^'"\`]*['"\`])`;
export const ENDPOINT_RE_SRC = `\\b(?:endpoint|url|path|route)\\b[ \\t]*:[ \\t]*(${_TOKEN}(?:[ \\t]*\\+[ \\t]*${_TOKEN})*)`;
const _ENDPOINT_RE = new RegExp(ENDPOINT_RE_SRC, "g");

// Resolve `baseUrl + '/{id}'` to `/…/{id}` against the const map. A literal contributes its content; a known
// const its value; an unresolved token (a member access, a foreign symbol) aborts → null (never a partial route).
// Exported so the effect-inference call-site resolver resolves an endpoint expression identically (no duplicate).
export function resolveExpr(expr: string, consts: Map<string, string>): string | null {
  let out = "";
  for (const rawTok of expr.split("+")) {
    const tok = rawTok.trim();
    const lit = tok.match(/^['"`]([^'"`]*)['"`]$/);
    if (lit) { out += lit[1]; continue; }
    if (consts.has(tok)) { out += consts.get(tok)!; continue; }
    return null;
  }
  return out || null;
}

export function scan(file: string, text: string, masked?: MaskCtx): KeyHit[] {
  if (!_CLIENT_EXT.test(file)) return [];   // declarative CLIENT config is JS/TS/Vue
  const src = masked?.comments ?? maskComments(text);
  if (!/\b(?:endpoint|url|path|route)\b/.test(src)) return [];
  const consts = new Map<string, string>();
  let cm: RegExpExecArray | null; _CONST_RE.lastIndex = 0;
  while ((cm = _CONST_RE.exec(src))) if (!consts.has(cm[1])) consts.set(cm[1], cm[2]);
  const out: KeyHit[] = [];
  const seen = new Set<string>();
  let em: RegExpExecArray | null; _ENDPOINT_RE.lastIndex = 0;
  while ((em = _ENDPOINT_RE.exec(src))) {
    // require the API-CALL descriptor shape — a `method`/`verb` sibling on the SAME line/entry as the endpoint
    // — so a plain front-end router config (`{ path: '/home', component: X }`) isn't mistaken for an HTTP route.
    // (A char window leaked an ADJACENT entry's `method:`; the descriptor map writes one entry per line.)
    const ls = src.lastIndexOf("\n", em.index) + 1;
    const le = src.indexOf("\n", em.index);
    const lineText = src.slice(ls, le === -1 ? src.length : le);
    if (!/\b(?:method|verb)\b[ \t]*:/.test(lineText)) continue;
    const route = resolveExpr(em[1], consts);
    if (!route || !route.startsWith("/")) continue;
    const value = normPath(route);
    if (value === "/" || seen.has(value)) continue;
    seen.add(value);
    out.push({ kind: HTTP_ROUTE_META.kind, value, line: lineOf(text, em.index), produces: false });   // a consumer (the client calls it)
  }
  return out;
}

export const ENDPOINT_MAP: KeyKind = {
  ...HTTP_ROUTE_META,
  name: "endpoint-map",
  blurb: "declarative API-client { endpoint, method } map ⇄ route handler — the config-driven fetch the call-site scan can't see",
  scan,
};
