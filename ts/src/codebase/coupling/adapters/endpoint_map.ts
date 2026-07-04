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

// The innermost `{…}` object enclosing `idx` — the descriptor an `endpoint:` lives in. Used to look for a
// method/verb SIBLING across the WHOLE entry (any line), not just the endpoint's line, so a multi-line
// `{ endpoint, method }` is recognised while a `{ path, component }` router config (no method/verb) is rejected.
function _enclosingObject(src: string, idx: number): string {
  let depth = 0, open = -1;
  for (let i = idx; i >= 0; i--) { const c = src[i]; if (c === "}") depth++; else if (c === "{") { if (depth === 0) { open = i; break; } depth--; } }
  if (open < 0) return "";
  let d = 0;
  for (let i = open; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) return src.slice(open, i + 1); }
  return src.slice(open);
}

// The OPERATION KEY the descriptor is declared under — `"updateBooking": { endpoint, method }` → "updateBooking".
// It names the boundary far more usefully than the raw route (`/booking/v1/*`), so it becomes the node label. The
// scan-back from the `endpoint:` position hits the descriptor's own `{` first (the route value, with any `{id}`,
// comes AFTER `endpoint:`), then the key sits immediately before it.
function _descriptorKey(src: string, idx: number): string | undefined {
  let depth = 0, open = -1;
  for (let i = idx; i >= 0; i--) { const c = src[i]; if (c === "}") depth++; else if (c === "{") { if (depth === 0) { open = i; break; } depth--; } }
  if (open < 0) return undefined;
  const m = src.slice(0, open).match(/(['"`]?)([A-Za-z_$][\w$]*)\1[ \t]*:[ \t]*$/);
  return m ? m[2] : undefined;
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
    // require the API-CALL descriptor shape — a `method`/`verb` sibling within the SAME `{…}` descriptor object
    // — so a front-end router config (`{ path: '/home', component: X }`) isn't mistaken for an HTTP route, while a
    // MULTI-LINE descriptor (`{ endpoint: …,\n method: … }` — the COMMON real shape) is still recognised. (A
    // same-LINE check rejected every multi-line entry, so a whole declarative client silently failed to ground.)
    if (!/\b(?:method|verb)\b[ \t]*:/.test(_enclosingObject(src, em.index))) continue;
    const route = resolveExpr(em[1], consts);
    if (!route || !route.startsWith("/")) continue;
    const value = normPath(route);
    if (value === "/" || seen.has(value)) continue;
    seen.add(value);
    const label = _descriptorKey(src, em.index);   // the operation name (`updateBooking`) — the boundary's human label
    out.push({ kind: HTTP_ROUTE_META.kind, value, line: lineOf(text, em.index), produces: false, ...(label ? { label } : {}) });   // a consumer (the client calls it)
    // KNOWN GAP (booking_app_concern.test.ts `.todo`): two ops on the SAME path differing only by HTTP METHOD
    // (`getBookings` GET + `createBooking` POST → the bare base) collapse to ONE key here (the index is keyed by
    // (kind,value), no method) → the second op (createBooking) is invisible on the concern map. A real fix needs
    // a method-aware key on BOTH sides (JS descriptor verb ⇄ Java @GET/@POST), not just this scan.
  }
  return out;
}

export const ENDPOINT_MAP: KeyKind = {
  ...HTTP_ROUTE_META,
  name: "endpoint-map",
  blurb: "declarative API-client { endpoint, method } map ⇄ route handler — the config-driven fetch the call-site scan can't see",
  scan,
};
