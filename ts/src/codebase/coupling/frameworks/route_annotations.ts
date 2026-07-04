// FRAMEWORK REGISTRY — route/annotation VOCABULARY (the declarative half of framework support). The structural
// scan (annotation_route.ts) is framework-AGNOSTIC: it keys on the SHAPE `@Name("/literal")` and composes a
// class base with method paths generically. The only per-framework fact is WHICH annotation names declare a
// route, and WHICH HTTP verb each implies — that is DATA, not code. This table is the single source of truth for
// that data, so "add a framework" is "add rows", never engine surgery (Phase 2 loads extra rows from a config
// file, so the community extends it with ZERO recompile). Keep this table SMALL and declarative — no logic.
//
// (CLAUDE.md: a STRUCTURAL classification sourced from a registry, never a hardcoded list kept in sync by hand.)

// The HTTP verbs a route key can carry. `null`/absent = the annotation declares a route but not a verb (a bare
// JAX-RS `@Path` / Spring `@RequestMapping` — the verb is a SIBLING annotation or a `method=` argument).
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

export interface RouteAnnotation {
  annotation: string;        // the bare annotation/decorator name as written, WITHOUT the leading @ (e.g. "GetMapping")
  httpMethod?: HttpMethod;    // the verb it declares, if the name alone fixes it (Spring @GetMapping, Nest @Get, JAX-RS @GET)
  framework: string;         // provenance label (spring/jaxrs/nest/flask/…) — docs/debug only, NOT matched on
}

// The built-in catalogue. Extends across JVM (JAX-RS, Spring, Servlet, Feign), Node (NestJS), and Python (Flask
// decorator). A verb-less entry (`@Path`, `@RequestMapping`, `@route`, `@WebServlet`, `@RequestLine`) still
// declares a route — the composition/literal logic handles it; only the METHOD is unknown at the name.
export const ROUTE_ANNOTATIONS: RouteAnnotation[] = [
  // JAX-RS (Jakarta/Java EE)
  { annotation: "Path",          framework: "jaxrs" },
  { annotation: "GET",           httpMethod: "GET",    framework: "jaxrs" },
  { annotation: "POST",          httpMethod: "POST",   framework: "jaxrs" },
  { annotation: "PUT",           httpMethod: "PUT",    framework: "jaxrs" },
  { annotation: "DELETE",        httpMethod: "DELETE", framework: "jaxrs" },
  { annotation: "PATCH",         httpMethod: "PATCH",  framework: "jaxrs" },
  { annotation: "HEAD",          httpMethod: "HEAD",   framework: "jaxrs" },
  { annotation: "OPTIONS",       httpMethod: "OPTIONS", framework: "jaxrs" },
  // Spring MVC / WebFlux
  { annotation: "RequestMapping", framework: "spring" },   // verb lives in a `method=` arg (not name-fixed)
  { annotation: "GetMapping",    httpMethod: "GET",    framework: "spring" },
  { annotation: "PostMapping",   httpMethod: "POST",   framework: "spring" },
  { annotation: "PutMapping",    httpMethod: "PUT",    framework: "spring" },
  { annotation: "DeleteMapping", httpMethod: "DELETE", framework: "spring" },
  { annotation: "PatchMapping",  httpMethod: "PATCH",  framework: "spring" },
  // NestJS (Node) — method decorators
  { annotation: "Get",           httpMethod: "GET",    framework: "nest" },
  { annotation: "Post",          httpMethod: "POST",   framework: "nest" },
  { annotation: "Put",           httpMethod: "PUT",    framework: "nest" },
  { annotation: "Delete",        httpMethod: "DELETE", framework: "nest" },
  { annotation: "Patch",         httpMethod: "PATCH",  framework: "nest" },
  // Flask (Python) decorator, Feign client (Java), Servlet (Java) — route present, verb in args/string
  { annotation: "route",         framework: "flask" },
  { annotation: "RequestLine",   framework: "feign" },
  { annotation: "WebServlet",    framework: "servlet" },
];

// Extra entries registered at runtime (Phase 2: from a config file / plugin). Kept separate so the built-in
// catalogue stays a pure literal and `resetRouteAnnotations()` can restore it in tests.
let _extra: RouteAnnotation[] = [];
export function registerRouteAnnotations(entries: RouteAnnotation[]): void { _extra = _extra.concat(entries); _rebuild(); }
export function _resetRouteAnnotations(): void { _extra = []; _rebuild(); }

// Derived lookups (rebuilt when the registry changes) — what the adapter consumes: the NAME set (is this a route
// annotation?) and the NAME→verb map (what HTTP method does it declare?).
let _names = new Set<string>();
let _method = new Map<string, HttpMethod>();
function _rebuild(): void {
  _names = new Set<string>();
  _method = new Map<string, HttpMethod>();
  for (const r of [...ROUTE_ANNOTATIONS, ..._extra]) { _names.add(r.annotation); if (r.httpMethod) _method.set(r.annotation, r.httpMethod); }
}
_rebuild();

export function isRouteAnnotation(name: string): boolean { return _names.has(name); }
export function routeAnnotationMethod(name: string): HttpMethod | undefined { return _method.get(name); }
export function routeAnnotationNames(): ReadonlySet<string> { return _names; }
