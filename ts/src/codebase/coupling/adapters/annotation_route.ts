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
  return out;
}

export const ANNOTATION_ROUTE_ADAPTER: KeyKind = { ...HTTP_ROUTE_META, name: "annotation-route", blurb: "@GetMapping/@Path/@app.route(\"/path\") ⇄ fetch — cross-stack HTTP-route coupling", scan };
