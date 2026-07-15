// FRAMEWORK adapter: an HTTP ROUTE — the SECOND data-flow boundary a UI crosses to reach the backend.
// A front-end page does not touch the DB; it `fetch("/api/…")`s a route handler that does. That hop is
// carried by a SHARED PATH (the URL), with no import/call edge — exactly the shape this rung grounds.
//
// Two sides, asymmetric in where the key VALUE comes from:
//   • the HANDLER (producer) — a file-routing convention: Next.js App Router `app/**/route.ts` exporting
//     GET/POST/… , Pages Router `pages/api/**`, or a Supabase/Deno EDGE FUNCTION `**/functions/<slug>/
//     index.*` (an anonymous `Deno.serve(…)` handler, served at `/functions/v1/<slug>`). The path is
//     DERIVED FROM THE FILE PATH (the handler body never contains its own URL), so the hit is anchored
//     at the exported method (Next) or the serve call (edge).
//   • the CALLER (consumer) — a `fetch`/axios/ky call whose first arg is a "/…" string LITERAL, or a
//     `supabase.functions.invoke('slug')` SDK call (which carries the slug, not a URL).
// Both sides normalise dynamic segments to `*` (`[id]` ⇄ `${id}`) so they meet on one key. JS/TS only.
import { endsWithSourceExt } from "../../../core/resolve/languages/index.js";
import type { KeyHit, KeyKind, MaskCtx } from "../types.js";
import { lineOf, maskComments } from "./util.js";
import { httpClientCallRegex } from "../frameworks/http_clients.js";

export const HTTP_ROUTE_META = { kind: "http-route", nodeKind: "route", produceEdge: "route-serve", consumeEdge: "route-fetch", handlerEdge: "route-serve" } as const;

const JS_EXT = /\.(?:[mc]?[jt]sx?)$/;                       // .ts .tsx .js .jsx .mjs .cjs .mts .cts
const ROUTE_FILE = /(?:^|\/)route\.(?:[mc]?[jt]sx?)$/;       // Next.js App Router handler file
// Supabase / Deno EDGE FUNCTION: `**/functions/<slug>/index.*` served at `/functions/v1/<slug>`. The
// `(?!_)` drops `_shared` and other underscore-prefixed support dirs (Supabase's convention for non-
// functions). The handler is an anonymous `Deno.serve(…)` callback (no method export), so its hit is
// anchored at the serve call; a file matching the path but without a serve call (e.g. a `types/index.ts`)
// is NOT a function and emits nothing.
const EDGE_FN = /(?:^|\/)functions\/(?!_)([^/]+)\/index\.(?:[mc]?[jt]sx?)$/;
const EDGE_SERVE = /\b(?:Deno\.serve|serve)\s*\(/;
// A Supabase-JS invoke of an edge function: `supabase.functions.invoke('slug')` — the consumer side.
const INVOKE_CALL = /\bfunctions\.invoke\s*\(\s*[`'"]([^`'"]+)/g;

// Collapse a URL/file path to its shared key so the two sides MEET regardless of how each spells a
// dynamic segment: JS `${id}`/Next `[id]`/`[...slug]`, Spring/OpenAPI `{id}`, Rails/Express `:id`,
// Flask/werkzeug `<id>` → all `*`. Drop query/hash + trailing slash. EXPORTED: discover_keys reuses it
// to normalise LLM-proposed route values onto the same key as the deterministic floor.
export function normPath(p: string): string {
  p = p.split(/[?#]/)[0].replace(/\/{2,}/g, "/");
  p = p.split("/").map((s) => (s.startsWith(":") || /[[\]{}<>]/.test(s) ? "*" : s)).join("/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p;
}

// ROUTE-SPECIFICITY matching — a fuzzy fallback for `otherSide` (coupling/index.ts): two route keys can share
// only a SUFFIX (a full-URL caller `/api/booking/summarize/*/*` vs a method-level `/summarize/*/*` handler), so
// an exact-key lookup misses the coupling. Scored by shared LITERAL segment count so a generic (1-literal)
// fragment can't outrank — or wrongly ground — a more specific (≥2-literal) match. `routeSuffixMatch` is the
// boolean form (≥1 shared literal).
export const routeSegs = (value: string): string[] => value.split("/").filter(Boolean);   // keep "*" (a path param) as a wildcard segment
const _segEq = (a: string, b: string): boolean => a === b || a === "*" || b === "*";   // a `{param}`/`*` matches any literal segment
export function routeMatchSpecificity(a: string, b: string): number {
  const A = routeSegs(a), B = routeSegs(b);
  if (!A.length || !B.length) return -1;
  const [long, short] = A.length >= B.length ? [A, B] : [B, A];
  let best = -1;
  for (let off = 0; off < long.length; off++) {
    let i = 0, lit = 0;
    while (i < short.length && off + i < long.length && _segEq(long[off + i], short[i])) {
      if (short[i] !== "*" && long[off + i] !== "*") lit++;
      i++;
    }
    if ((i === short.length || off + i === long.length) && i >= 1) best = Math.max(best, lit);
  }
  return best;
}
export function routeSuffixMatch(a: string, b: string): boolean { return routeMatchSpecificity(a, b) >= 1; }
// A route with NO literal segments (all `*`/params — `/*`, `/`, `/*/*`) is NON-DISCRIMINATING: it matches every
// path, so an EXACT-key crossing on it couples a caller to every handler that happens to share the bare wildcard
// (keycloak `users.ts` yields both `/admin/realms/*/users` AND a bare `/*` from its `/{id}` methods; the `/*`
// dragged in AdminRoot/Organizations/… — a grab-bag). Such a route can't ground a real cross-stack counterpart.
export function isBareWildcardRoute(value: string): boolean {
  const segs = routeSegs(value);
  return segs.length === 0 || segs.every((s) => s === "*");
}

// The URL a route-handler FILE serves, from its location (file-based routing). null if not a handler file.
function handler_path(file: string): string | null {
  const edge = EDGE_FN.exec(file);
  if (edge) return normPath("/functions/v1/" + edge[1]);
  const parts = file.split("/");
  const base = parts[parts.length - 1];
  // App Router: app/<segs>/route.ts — segments between `app` and the route file (route groups `(x)` and
  // parallel/intercepting slots `@x`/`(.)x` carry no URL segment and are dropped).
  if (ROUTE_FILE.test(file)) {
    const appIdx = parts.indexOf("app");
    if (appIdx < 0) return null;
    const segs = parts.slice(appIdx + 1, parts.length - 1).filter((s) => !(s.startsWith("(") && s.endsWith(")")) && !s.startsWith("@"));
    return normPath("/" + segs.join("/"));
  }
  // Pages Router: pages/api/<segs>.ts — the path is `/api/…`, an `index` basename maps to its directory.
  const pagesIdx = parts.indexOf("pages");
  if (pagesIdx >= 0 && parts[pagesIdx + 1] === "api") {
    const tail = parts.slice(pagesIdx + 1, parts.length - 1);
    const name = base.replace(JS_EXT, "");
    if (name !== "index") tail.push(name);
    return normPath("/" + tail.join("/"));
  }
  return null;
}

// HTTP-method handlers a route file exports (App Router `export function GET`/`export const GET = …`,
// Pages Router `export default`). Each is anchored at its own line so a per-method anchor lands in range.
const METHOD_EXPORT = /\bexport\s+(?:async\s+)?(?:default\b|(?:function\s+|const\s+|let\s+|var\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b)/g;
// A fetch-like call whose first arg is a string path. WHICH receiver names count (fetch / $fetch / useFetch /
// $http[.method] / $resource / request / axios[.method] / ky[.method]) is per-ecosystem VOCABULARY, sourced from
// the http-client registry (community-extensible via `frameworks.json` httpClients) — NOT baked here. The scan
// SHAPE (a string-literal path arg) is generic. (`$http({url:…})` config-object form isn't caught — only the
// positional-path form, the common case. A CUSTOM axios/ky INSTANCE — `const api = axios.create();
// api.get("/x")` — is NOT caught: the receiver name is arbitrary and a bare `.get("/x")` would collide with
// Express route DEFINITIONS; that case is the LLM tier's job.) NB: the registry builds a `(?<![\w$])` lookbehind
// (excludes word-char/`$` only, NOT `.`) so member forms like `this.$http.get` match and `$http`/`$fetch` aren't
// silently missed the way a leading `\b` would (both sides non-word).
// REVERSE CROSS-EDGE (Brice): a route literal that is NOT at a fetch site — the ubiquitous carrier-indirection
// where the URL is stashed in a field and the `http.*` call reads the field: Angular/JHipster
// `resourceUrl = getEndpointFor('api/operations'); http.post(this.resourceUrl, …)`. The FETCH_CALL above sees a
// variable at the call site and grounds nothing, but the literal IS in the file (one carrier hop away). We're
// holding the GROUNDED backend route from the footprint, so rather than trace the carrier we ground the literal
// DIRECTLY as a route consumer and let routeMatchSpecificity bridge it (subpath-safe, class+method composed).
// Guarded to route-SHAPED literals — ≥2 path segments, no file extension — so it grounds real routes, not any
// string; a coincidental literal only crosses if a backend route with ≥2 shared LITERAL segments actually exists.
const BARE_ROUTE = /[`'"](\/?[A-Za-z][\w-]*(?:\/[\w{}$:.*-]+)+)[`'"]/g;

function scan(file: string, text: string, masked?: MaskCtx): KeyHit[] {
  if (!endsWithSourceExt(file) || !JS_EXT.test(file)) return [];
  text = masked?.comments ?? maskComments(text);   // a `fetch("/api/x")` (or `export function GET`) in a comment is not a real route (shared mask across adapters)
  const out: KeyHit[] = [];
  const served = handler_path(file);
  if (served && served !== "/") {
    if (EDGE_FN.test(file)) {
      // anonymous Deno.serve handler — anchor the hit at the serve call; no serve ⇒ not a function.
      const s = EDGE_SERVE.exec(text);
      if (s) out.push({ kind: "http-route", value: served, line: lineOf(text, s.index), produces: true });
    } else {
      let m: RegExpExecArray | null;
      METHOD_EXPORT.lastIndex = 0;
      while ((m = METHOD_EXPORT.exec(text)) !== null) out.push({ kind: "http-route", value: served, line: lineOf(text, m.index), produces: true });
    }
  }
  let c: RegExpExecArray | null;
  const FETCH_CALL = httpClientCallRegex();
  FETCH_CALL.lastIndex = 0;
  while ((c = FETCH_CALL.exec(text)) !== null) {
    const raw = c[1];
    if (!raw.startsWith("/")) continue;                    // only same-origin absolute paths couple to a route
    let path = normPath(raw);
    // DYNAMIC TAIL: `$http.put("/x/y/" + id)` concatenates the id, so the literal ENDS at the trailing
    // slash and loses the dynamic segment — leaving `/x/y`, which never meets a backend `@Path("/x/y/{id}")`
    // (→ `/x/y/*`). When a path literal ends in `/` and is immediately followed by `+` (concatenation),
    // the next segment IS dynamic: restore the `*` so the front-end call grounds to the backend route.
    if (raw.endsWith("/") && path !== "/" && /^[`'"]\s*\+/.test(text.slice(c.index + c[0].length))) path += "/*";
    if (path !== "/") out.push({ kind: "http-route", value: path, line: lineOf(text, c.index), produces: false });
  }
  // `functions.invoke('slug')` consumer → the edge function's served path (the SDK call carries no URL).
  let v: RegExpExecArray | null;
  INVOKE_CALL.lastIndex = 0;
  while ((v = INVOKE_CALL.exec(text)) !== null) {
    const slug = v[1].replace(/^\/+/, "");
    if (slug) out.push({ kind: "http-route", value: normPath("/functions/v1/" + slug), line: lineOf(text, v.index), produces: false });
  }
  // REVERSE CROSS-EDGE — indirected route literals (see BARE_ROUTE). Skip anything already grounded at a fetch
  // site (same value) so we only ADD the ones the site-based scan missed; route-shape + ≥2 literal segments gate.
  const grounded = new Set(out.filter((h) => !h.produces).map((h) => h.value));
  let b: RegExpExecArray | null;
  BARE_ROUTE.lastIndex = 0;
  while ((b = BARE_ROUTE.exec(text)) !== null) {
    const raw = b[1];
    if (/\.(?:[mc]?[jt]sx?|json|css|s[ca]ss|html|png|svg|jpe?g|md)$/.test(raw)) continue;   // a file path, not a route
    const path = normPath(raw);
    if (path.split("/").filter((s) => s && s !== "*").length < 2) continue;                  // ≥2 LITERAL segments — a single word can't ground
    if (grounded.has(path)) continue;                                                        // already grounded at its fetch site
    grounded.add(path);
    out.push({ kind: "http-route", value: path, line: lineOf(text, b.index), produces: false });
  }
  return out;
}

export const HTTP_ROUTE: KeyKind = { ...HTTP_ROUTE_META, name: "next-route", blurb: "Next.js file-routed handler ⇄ fetch/$http(\"/path\") — HTTP-route coupling", scan };
