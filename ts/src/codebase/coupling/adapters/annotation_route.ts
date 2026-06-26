// AGNOSTIC annotation/decorator route adapter — the HANDLER side of the HTTP-route boundary for any
// stack that declares its route in an ANNOTATION rather than by file location. A method/class annotated
// `@WebServlet("/document/*")` (Servlet), `@Path("/x")` (JAX-RS), `@GetMapping("/x")` (Spring),
// `@app.route("/x")` (Flask decorator), `@Get("/x")` (Nest) all share ONE structural shape: an
// annotation whose argument is a URL-path string literal. We key on that SHAPE — `@<name>( … "/path" … )`
// with a leading-slash literal — NOT on the annotation's name, so there is no per-framework list to keep
// in sync (same principle as is_framework_entry's annotation-PRESENCE signal). Emits the same
// `http-route` kind as the fetch/$http caller side, so a caller grounds to it through the shared index.
import type { KeyHit, KeyKind, MaskCtx } from "../types.js";
import { HTTP_ROUTE_META, normPath } from "./http_route.js";
import { lineOf, maskComments } from "./util.js";
import { endsWithSourceExt } from "../../../core/resolve/languages/index.js";

// ROUTE-annotation idiom — a closed cross-framework set of annotation NAMES that declare an HTTP route (JAX-RS
// @Path/@GET…, Spring @*Mapping, Nest @Get…, Flask @route, Feign @RequestLine, Servlet @WebServlet). The bare
// regex pass below is name-AGNOSTIC (it judges the literal), but a route SPLIT across a class @Path + a method
// @Path with PLAIN relative literals (`member/booking` + `v1`, no slash, no path-var) is invisible to it — the
// only signal that `member/booking` IS a route is the annotation NAME. So COMPOSITION keys on this vocabulary.
const _ROUTE_ANNOT = new Set(["Path", "GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH",
  "GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping", "RequestMapping",
  "Get", "Post", "Put", "Delete", "Patch", "route", "WebServlet", "RequestLine"]);
const _NAMED_ANNOT = /@(\w+)\s*\(\s*["'`]([^"'`\s]+)["'`]/g;        // @Name("literal") — name + the literal
const _join = (base: string, sub: string) => normPath("/" + [base, sub].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"));
// the next non-annotation/non-blank code line AFTER the annotation at `at` — to tell a CLASS base from a METHOD
// path. Starts at the line FOLLOWING the annotation's own line (so the annotation's own `)` isn't misread).
function _nextDecl(text: string, at: number): string {
  const nl = text.indexOf("\n", at);
  for (const raw of text.slice(nl < 0 ? text.length : nl + 1).split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("@")) continue;
    return l;
  }
  return "";
}

// COMPOSE a class-level route annotation with each method's — the JAX-RS/Spring `@Path("member/booking")` class
// + `@Path("v1")` method ⇒ `/member/booking/v1`, the full endpoint the front-end's URL grounds to. Stateful
// top-to-bottom scan (a route annotation followed by a `class` decl is the BASE; otherwise it's a method path
// composed onto the current base). Catches the PLAIN-relative split the literal-only pass can't see.
function composedRoutes(text: string): KeyHit[] {
  const out: KeyHit[] = [];
  let classBase: string | null = null;
  let m: RegExpExecArray | null;
  _NAMED_ANNOT.lastIndex = 0;
  while ((m = _NAMED_ANNOT.exec(text)) !== null) {
    const [name, lit] = [m[1], m[2]];
    if (!_ROUTE_ANNOT.has(name)) continue;
    if (/\b(class|interface|enum|record)\b/.test(_nextDecl(text, m.index))) { classBase = lit; continue; }   // class base
    const full = lit.startsWith("/") ? normPath(lit) : _join(classBase ?? "", lit);   // method path (absolute overrides the base)
    if (full && full !== "/") out.push({ kind: "http-route", value: full, line: lineOf(text, m.index), produces: true });
  }
  return out;
}

// `@Name( …anything… "<literal>" …anything… )` — the annotation name only ANCHORS the match (`@\w[\w.]*`);
// we judge the LITERAL, framework-agnostically (no per-framework name list). A literal is a route when it is:
//   • ABSOLUTE — `/x/y` (`@WebServlet("/x")`, `@GetMapping("/x")`, `@RequestMapping(path="/x")`), OR
//   • RELATIVE WITH A PATH-VARIABLE — `generateFileNote/{id}` / `users/<id>` / `users/:id`. JAX-RS & Spring
//     split a route across a class `@Path("fileNote")` + method `@Path("generateFileNote/{id}")` with NO
//     leading slash, under an external base (`/manage/rest`). The PATH-VARIABLE is the agnostic "this is a
//     route" signal when the slash is absent; the engine's route SUFFIX matcher then grounds the relative
//     handler to the front-end's FULL URL (`/manage/rest/fileNote/generateFileNote/*`) — no class-combine
//     or base-path needed. A plain literal with no slash/var (`@Column("user_id")`, `@Named("x")`) is NOT a route.
const ANNOTATION_ARG = /@\w[\w.]*\s*\([^)]*?["'`]([^"'`\s]+)["'`]/g;
const PATHISH = /^[\w\-./{}:<>*~%]+$/;                       // path characters only — excludes prose/SQL/regex
const PATH_VAR = /\{[^}]*\}|<[^>]*>|(?:^|\/):[A-Za-z_]/;     // {id} / <id> / :id — a dynamic route segment
function routeValue(s: string): string | null {
  if (!PATHISH.test(s)) return null;
  if (s.startsWith("/")) return normPath(s);                 // absolute (unchanged behaviour)
  if (PATH_VAR.test(s)) return normPath("/" + s);            // relative route → leading slash for a consistent key
  return null;
}

function scan(file: string, text: string, masked?: MaskCtx): KeyHit[] {
  if (!endsWithSourceExt(file)) return [];
  text = masked?.comments ?? maskComments(text);   // an annotation inside a comment is not a real route declaration (shared mask across adapters)
  const out: KeyHit[] = [];
  let m: RegExpExecArray | null;
  ANNOTATION_ARG.lastIndex = 0;
  while ((m = ANNOTATION_ARG.exec(text)) !== null) {
    const path = routeValue(m[1]);
    if (path && path !== "/") out.push({ kind: "http-route", value: path, line: lineOf(text, m.index), produces: true });
  }
  // ⊕ class@Path + method@Path COMPOSED endpoints (the plain-relative split the literal pass can't recognise)
  const seen = new Set(out.map((h) => h.value));
  for (const h of composedRoutes(text)) if (!seen.has(h.value)) { seen.add(h.value); out.push(h); }
  return out;
}

export const ANNOTATION_ROUTE_ADAPTER: KeyKind = { ...HTTP_ROUTE_META, name: "annotation-route", blurb: "@GetMapping/@Path/@app.route(\"/path\") ⇄ fetch — cross-stack HTTP-route coupling", scan };
