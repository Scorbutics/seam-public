// CLASS-BASE-ROUTE inheritance — the CONSUMER-side mirror of the sub-resource composer (route_composer.ts).
// An SDK client-resource class declares its route BASE PATH once (in the class, typically the constructor's
// `super(client, { path: "/admin/realms/{realm}/users" })`), and each request METHOD inherits it — a bare
// `create = this.makeRequest({ method: "POST" })` calls POST on the base path; a method with its OWN `path:`
// composes onto it. Coupling keys are attributed SPAN-LOCALLY (collectAnchorKeys scans only [node.lo,node.hi]),
// so when the footprint reaches the `create` METHOD, its span (just `makeRequest({method})`) carries NO route
// literal — the base path sits in the constructor, outside the method — and the cross-stack crossing to the
// backend handler never materialises. This resolves each request method's FULL route AT ITS OWN LINE, so the
// method node owns the crossing (exactly like resolveHttpCallSites does for indirected http-client calls).
//
// General over the SDK-resource idiom (a class base path + per-method request builders), not one framework:
// the base path is any route literal passed to `super(...)` or declared as a class `path`/`baseUrl`/`basePath`
// field; a request method is any member assigned a `make*Request(...)` builder. The route it emits still has to
// GROUND against a backend producer, so a mis-attribution coming from a non-route class produces nothing.
import { lineOf } from "./adapters/util.js";
import { normPath } from "./adapters/http_route.js";
import type { KeyHit } from "./types.js";

const JS_EXT = /\.(?:[mc]?[jt]sx?)$/;
// the class BASE path — a route-shaped literal handed to `super(...)` (the Resource idiom) or a class field.
const BASE_SUPER = /\bsuper\s*\(\s*[\s\S]{0,400}?\bpath\s*:\s*["'`](\/[^"'`]+)["'`]/;
const BASE_FIELD = /\b(?:base(?:Url|Path)|path)\s*[:=]\s*["'`](\/[A-Za-z][^"'`]*)["'`]/;
// a request METHOD: a member assigned a `make…Request(...)` builder (arrow-valued field or method). Captures
// the member name; the call's own `path:`/`method:` are read from the bounded config window that follows.
const REQ_MEMBER = /(\w+)\s*=\s*(?:this\.)?make\w*[Rr]equest\b/g;
const OWN_PATH = /\bpath\s*:\s*["'`]([^"'`]+)["'`]/;
const OWN_METHOD = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i;

const _join = (base: string, sub: string): string => normPath(base.replace(/\/+$/, "") + "/" + sub.replace(/^\/+/, ""));

// Resolve each request method's full route (base ⊕ its own path), stamped at the METHOD's line so the footprint
// method node owns the crossing. Returns [] for a file that isn't an SDK resource (no base path or no builders).
export function resolveResourceRoutes(file: string, text: string): KeyHit[] {
  if (!JS_EXT.test(file)) return [];
  if (!/make\w*[Rr]equest/.test(text)) return [];                 // cheap gate: no request builder → not this idiom
  const base = (BASE_SUPER.exec(text) ?? BASE_FIELD.exec(text))?.[1];
  if (!base) return [];
  const out: KeyHit[] = [];
  let m: RegExpExecArray | null;
  REQ_MEMBER.lastIndex = 0;
  while ((m = REQ_MEMBER.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    // bound the config to THIS builder call — up to the next request member (so a path-less method can't
    // borrow the next method's `path:`).
    const nextIdx = after.search(/\n\s*(?:public |private |protected |readonly )*\w+\s*=\s*(?:this\.)?make\w*[Rr]equest\b/);
    const window = after.slice(0, nextIdx >= 0 ? nextIdx : 600);
    const own = OWN_PATH.exec(window)?.[1];
    const value = own ? _join(base, own) : normPath(base);
    if (value === "/") continue;
    const method = OWN_METHOD.exec(window)?.[1]?.toUpperCase();
    out.push({ kind: "http-route", value, line: lineOf(text, m.index), produces: false, ...(method ? { method } : {}) });
  }
  return out;
}
