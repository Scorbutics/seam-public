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

// `@Name( …anything… "<a path-shaped string literal>" …anything… )`. The annotation's name is captured
// only to anchor the match (`@\w[\w.]*`); the route is the first leading-slash string literal inside the
// parens, so it catches both positional (`@WebServlet("/x")`) and named (`@RequestMapping(path="/x")`).
const ANNOTATION_ROUTE = /@\w[\w.]*\s*\([^)]*?["'`](\/[^"'`\s]*)["'`]/g;

function scan(file: string, text: string, masked?: MaskCtx): KeyHit[] {
  if (!endsWithSourceExt(file)) return [];
  text = masked?.comments ?? maskComments(text);   // an annotation inside a comment is not a real route declaration (shared mask across adapters)
  const out: KeyHit[] = [];
  let m: RegExpExecArray | null;
  ANNOTATION_ROUTE.lastIndex = 0;
  while ((m = ANNOTATION_ROUTE.exec(text)) !== null) {
    const path = normPath(m[1]);
    if (path !== "/") out.push({ kind: "http-route", value: path, line: lineOf(text, m.index), produces: true });
  }
  return out;
}

export const ANNOTATION_ROUTE_ADAPTER: KeyKind = { ...HTTP_ROUTE_META, name: "annotation-route", blurb: "@GetMapping/@Path/@app.route(\"/path\") ⇄ fetch — cross-stack HTTP-route coupling", scan };
