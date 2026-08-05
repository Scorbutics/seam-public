// `--locate <name>` — WHERE DOES THIS NAME LIVE?
//
// The mechanical half of anchoring, and nothing more. Measured in bench/grep-vs-seam: every Seam arm opened by
// hunting for a definition it had already decided it wanted — `rg "export .*\bcn\b"`, `rg "function cn|const cn"`,
// then reading files to confirm — 3 to 8 calls before the first real query, on every run.
//
// IT DOES NOT PICK A CENTER. Choosing which symbol answers a question is a semantic judgement that belongs to the
// caller, and the engine's text-matcher is measurably worse at it — SKILL.md tells an agent to always pass
// `--center` for exactly that reason. So when a name has several definitions this prints ALL of them with what
// distinguishes them and lets the caller decide. It resolves an address; it does not form an opinion.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "./args.js";
import { loadAddon } from "../codebase/rust_core.js";
import { err } from "./util.js";
import { at } from "../codebase/render/shapes.js";

// THE DECLARATION, NOT THE ANCHOR LINE.
//
// `d.signature` is the text at the def's own line, and for an annotated/decorated member that line is the
// ANNOTATION. Measured on keycloak: `--locate updateRealm` returned 7 definitions of which FOUR showed only
// `@PUT`, `@Override`, `@PUT`, `@Test` — nothing a caller can act on. And `--locate` is not a side road: across
// six benchmark runs the seam arm made 48 Seam calls and 35 of them were `--locate` (73%), each one followed by
// a `Read` of the file it had just named. A locate that shows `@PUT` has resolved an address and bought nothing.
//
// So: print from the def's line THROUGH the first line that actually declares something, capped. The annotation
// is kept — `@PUT` is real information about a route — it just stops being the whole answer.
const _fileCache = new Map<string, string[] | null>();
const _linesOf = (repo: string, file: string): string[] | null => {
  const key = `${repo}\u0000${file}`;
  const hit = _fileCache.get(key);
  if (hit !== undefined) return hit;
  let v: string[] | null = null;
  try { v = readFileSync(join(repo, file), "utf-8").split("\n"); } catch { v = null; }
  _fileCache.set(key, v);
  return v;
};
/// A line that only decorates: an annotation/decorator, a comment, or blank. Language-agnostic on purpose —
/// `@Foo` covers Java/Kotlin/TS-decorators/Python, and the comment forms cover the rest. It never SKIPS such a
/// line, it only keeps looking for the declaration underneath.
const _isDecoration = (l: string): boolean => {
  const t = l.trim();
  return t === "" || /^@[\w.]+/.test(t) || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")
    || t.startsWith("/*") || t.startsWith("<!--");
};
/// How far below the def's line to look for the declaration. Keycloak's `updateRealm` carries a 15-line
/// OpenAPI annotation block, so a small window returns the annotation and nothing else — the exact failure
/// this function exists to remove.
const _MAX_SCAN = 60;

/// The def's line plus the line that actually DECLARES it, with the annotation block between them elided.
///
/// Depth-tracked, because an annotation's arguments span lines and its continuations are not decorations by
/// any textual test: `@Operation(summary = "...",` / `description = "...")` — the second line looks like code.
/// Only a line at bracket depth ZERO can be the declaration, which is what makes this work on a 15-line
/// `@APIResponses(value = { ... })` block without a Java parser.
function declarationLines(repo: string, file: string, line: number, signature: string): string[] {
  const src = _linesOf(repo, file);
  if (!src || !line || line < 1 || line > src.length) return signature ? [signature] : [];
  const first = src[line - 1];
  let depth = 0, decl: string | null = null, skipped = 0;
  for (let i = line - 1; i < Math.min(line - 1 + _MAX_SCAN, src.length); i++) {
    const t = src[i];
    if (depth === 0 && !_isDecoration(t)) { decl = t; break; }
    if (i > line - 1) skipped++;
    depth += (t.match(/[([{]/g) ?? []).length - (t.match(/[)\]}]/g) ?? []).length;
    if (depth < 0) depth = 0;
  }
  // No declaration within the window (or the def's line already IS one) → whatever we have, no elision.
  if (decl === null) return signature ? [signature] : [_trimEnd(first)];
  if (decl === first) return [_trimEnd(first)];
  const out = [first];
  // Say that something was skipped rather than silently splicing two non-adjacent lines together — a reader
  // must not think `@PUT` and the declaration are consecutive when 15 lines of annotation sit between them.
  if (skipped > 0) out.push(`  … ${skipped} line(s) of annotation`);
  out.push(decl);
  const real = [first, decl];
  const indents = real.filter((l) => l.trim()).map((l) => (l.match(/^[ \t]*/) as RegExpMatchArray)[0].length);
  const strip = indents.length ? Math.min(...indents) : 0;
  return out.map((l, k) => (k === 1 && skipped > 0 ? l : (l.trim() ? l.slice(strip) : "")).replace(/\s+$/, ""));
}
const _trimEnd = (l: string) => l.replace(/\s+$/, "").replace(/^[ \t]+/, "");

const row = (r: any, repo = "."): string => {
  const decl = declarationLines(repo, r.file, r.line, r.signature ?? "");
  const encl = r.enclosing ? `  in ${r.enclosing}` : "";
  // `signature` is ALREADY the full declaration text, so prefixing the symbol printed `cnexport function cn(`.
  // `file:line#symbol` — the LINE is what makes this a jump rather than a search. Without it a caller who has
  // just been told where a symbol lives still has to open the file and look, which is exactly what a benchmark
  // agent did: seven paging reads of a 1,449-line Java file after Seam had named it.
  return `- ${at(r.file, r.line)}#${r.symbol}   [${r.kind}${r.isTest ? ", TEST" : ""}]${encl}\n`
    + decl.map((l) => `    ${l}\n`).join("");
};

// ── ROUTE ADDRESSING ─────────────────────────────────────────────────────────────────────────────────────────
//
// A flow question names an HTTP SURFACE, not a symbol: "how does the admin UI read and update a realm" is
// addressed by `/admin/realms`, and until now `--locate "/admin/realms"` fell through to a PATH match and
// confidently answered `realms.ts#Realms` — the wrong end of the flow, stated as fact.
//
// MEASURED (bench/grep-vs-seam, keycloak, 2026-08-04): of 20 tool calls in one seam-arm run, SIXTEEN were the
// agent deriving by hand which Java class serves `PUT /admin/realms/{realm}` — sed on RealmsResource, grep on
// AdminRoot, three paging Reads of RealmAdminResource, three of RealmsAdminResource. The case's own ground
// truth calls that hop "not symbol-resolvable". It is resolved: the coupling floor grounds every `http-route`
// key with BOTH sides, repo-wide and cached. The data existed; it had no address. This gives it one.
const routeRows = (entries: any[]): string => {
  let out = "";
  for (const e of entries) {
    out += `- ${e.route}\n`;
    // SERVER FIRST. The question that sends an agent here is almost always "who handles this?" — the client
    // side it usually already has in hand (that is where it read the URL).
    for (const s of e.servers) out += `    serves   ${at(s.file, s.line)}\n`;
    for (const c of e.clients) out += `    fetches  ${at(c.file, c.line)}\n`;
    if (!e.servers.length) out += `    (no server side resolved in this repo — an outbound call, or the handler is not statically declared)\n`;
    if (!e.clients.length) out += `    (no client side resolved in this repo — an endpoint nothing here calls)\n`;
  }
  return out;
};

/// A route-shaped address: a path, not an identifier. `/admin/realms`, `api/v2/users`, `/users/{id}`.
const looksLikeRoute = (n: string): boolean => n.startsWith("/") || /^[\w-]+(\/[\w{}*:-]+){1,}$/.test(n);

export async function runLocate(a: Args): Promise<number> {
  const name = (a.locate ?? "").trim();
  if (!name) err("--locate needs a symbol or file name");
  const addon: any = loadAddon();

  // COMMA-SEPARATED NAMES — one call, one answer per name.
  //
  // MEASURED (bench/grep-vs-seam, keycloak, 2026-08-01). Anchor hunting dominated the Seam arm, but the call
  // count understated it: 12, 16 and 8 Bash calls carried 19, 23 and 10 `--locate` INVOCATIONS, because agents
  // were already chaining `--locate A; echo ===; --locate B` in one shell command. They wanted a batch and had
  // to fake one.
  //
  // And the natural spelling was worse than unsupported: `--locate "A,B"` looked up the LITERAL string `A,B`,
  // found nothing, and printed "No definition of 'A,B' found … grep is the right next step" — a confident false
  // negative for two symbols that both exist. That is the single failure this command must not have
  // (locate_recall.test.ts), reached through a spelling nobody had tested.
  if (name.includes(",")) {
    const groups: any[] = addon.locateNames(a.repo, name, 25, a.locateIn ?? undefined) ?? [];
    const found = groups.filter((g) => g.rows.length);
    process.stdout.write(`# Locate: ${groups.length} name(s)\n`
      + `${found.length} resolved, ${groups.length - found.length} not found — YOU choose which answers your question.\n\n`);
    for (const g of groups) {
      if (!g.rows.length) {
        // NAMED, not silently dropped. Which of the batch came back empty is exactly what a batch lookup is
        // asked, and a flat merged list could not say it.
        process.stdout.write(`## ${g.name} — no definition found (external package, dynamic, or spelled differently)\n\n`);
        continue;
      }
      process.stdout.write(`## ${g.name} — ${g.rows.length} definition(s)`
        + (g.total > g.rows.length ? ` of ${g.total} — narrow with \`--in <path-prefix>\`` : "") + `\n`);
      for (const r of g.rows) process.stdout.write(row(r, a.repo));
      process.stdout.write("\n");
    }
    process.stdout.write(`## Next\nPick one per name and pass it as --center "<file>#<symbol>".\n`);
    return 0;
  }

  // ROUTES FIRST for a route-shaped address. A leading `/` is never a symbol, so trying the symbol table
  // first can only produce the module-path false positive this branch exists to remove.
  if (looksLikeRoute(name)) {
    const entries: any[] = addon.locateRoutes?.(a.repo, name, 200) ?? [];
    if (entries.length) {
      const crossing = entries.filter((e) => e.servers.length && e.clients.length);
      // A CROSSING ANSWERS THE QUESTION; a one-sided route is context. `/admin/realms` matches 25 routes on
      // keycloak and exactly ONE has both sides — printing all 25 equally buries the answer in its own
      // context, which is the cost this command exists to remove. So: every crossing, then a short tail.
      const _TAIL = 5;
      const oneSided = entries.filter((e) => !(e.servers.length && e.clients.length));
      const shown = [...crossing, ...oneSided.slice(0, _TAIL)];
      process.stdout.write(`# Locate route: ${name}\n`
        + `${entries.length} route(s) matched; ${crossing.length} with BOTH sides resolved — `
        + `the crossing itself, from the coupling floor (no grow).\n\n`
        + routeRows(shown)
        + (oneSided.length > _TAIL
          // NOT silently truncated: the cut is stated with the flag that widens it, as everywhere else here.
          ? `\n(+${oneSided.length - _TAIL} more one-sided route(s) — narrow the path to see them)\n` : "")
        + `\n## Next\n`
        + `--center "<file>#<symbol>" on either side to trace it, or --scan --auto --center on the server\n`
        + `handler to see what it reaches.\n`);
      return 0;
    }
    // fall through: a slash-shaped name that matches no route may still be a file/module path
  }

  const groups: any[] = addon.locateNames(a.repo, name, 25, a.locateIn ?? undefined) ?? [];
  const rows: any[] = groups[0]?.rows ?? [];
  const total: number = groups[0]?.total ?? rows.length;

  // THE CUT, DECLARED. `--locate getRealm` on keycloak has 206 definitions; 25 are shown; the one the caller
  // wanted ranks 167th. Printing "25 definition(s)" for that is a silently partial answer that reads as
  // complete, and the transcripts show the only recourse an agent has: guess another name. Saying the true
  // total and naming the narrowing flag turns a second guess into a second, better-scoped call.
  const cutLine = total > rows.length
    ? `showing ${rows.length} of ${total} — NOT all of them. Narrow with \`--in <path-prefix>\` (e.g. --in ${(rows[0]?.file ?? "src/").split("/").slice(0, 2).join("/")}/).\n`
    : "";


  if (!rows.length) {
    // BEFORE DECLARING IT ABSENT, TRY THE ROUTE TABLE. `looksLikeRoute` only fires on a path shape (a leading
    // `/`, or `a/b`), so a route FRAGMENT reaches here as a failed symbol lookup — and the "grep is the right
    // next step" line then sends the caller hunting for a symbol that does not exist.
    //
    // MEASURED (bench/grep-vs-seam, keycloak). An agent read `ui-ext` out of the admin-UI source, asked Seam
    // for it, was told to grep, and spent SIX calls on `--locate UiExt` / `AdminUiExt` / `RealmUiExtResource`
    // / `find -iname "*UiExt*"` chasing a class that is not there. The route table holds six `ui-ext` routes.
    // Seam knew; it just would not answer unless the question was punctuated like a path.
    const routes: any[] = addon.locateRoutes?.(a.repo, name, 25) ?? [];
    if (routes.length) {
      process.stdout.write(`# Locate: ${name}\n`
        + `No SYMBOL of that name — but it names ${routes.length} ROUTE(s). Showing the crossing instead.\n\n`
        + routeRows(routes.slice(0, 8))
        + `\n## Next\n--center "<file>#<symbol>" on either side to trace it.\n`);
      return 0;
    }
    // An honest empty: say which corpus was searched, so the caller knows whether to widen or to spell it right.
    process.stdout.write(`No definition of '${name}' found in ${a.repo}${a.locateIn ? ` under '${a.locateIn}'` : ""}.\n`
      + `No route of that name either. It may be an external package symbol, defined dynamically, or spelled\n`
      + `differently — grep is the right next step.\n`);
    return 0;
  }

  const one = rows.length === 1;
  // A MODULE MATCH IS NOT A SYMBOL MATCH, and printing it as one is a lie of omission.
  //
  // MEASURED (bench/grep-vs-seam, cal-booking-flow, 2026-08-01): `--locate handleNewBooking` printed
  // "25 definition(s)" for a name that defines NOTHING — it is a directory of ~30 modules with no barrel and no
  // symbol of that name. The agent read that as "one of these 25 is what I asked for", could not see which, and
  // spent 7 of its 11 tool calls on ls/find looking for the entry point that does not exist. Three runs, same
  // dead end each time. The engine knew it had fallen back to a path match and said nothing.
  const viaModule = rows[0]?.viaModule === true;
  const noEntry = rows[0]?.moduleNoEntry === true;
  process.stdout.write(`# Locate: ${name}\n`
    + (viaModule
      ? `'${name}' is a MODULE (a directory or file), not a symbol — nothing declares that name.\n`
        + `${rows.length} definition(s) INSIDE it${noEntry ? "" : ", entry point(s) first"}.\n`
      : `${rows.length} definition(s)${one ? "" : " — YOU choose which one answers your question; this only resolves addresses"}\n`)
    + cutLine
    + (viaModule && noEntry
      // The honest negative. An agent that knows there is no way in stops looking for one; that is the whole
      // saving. Stating it costs one line and replaces a hunt.
      ? `NO ENTRY POINT: it has no index.* barrel and no '${name}' symbol, so there is no single way in.\n`
        + `Do NOT go looking for one — pick the member below that does the work, or anchor on a CALLER instead.\n`
      : "")
    + `\n`);
  for (const r of rows) process.stdout.write(row(r, a.repo));
  // The paste-ready line: this command exists to produce the argument of the NEXT one.
  process.stdout.write(`\n## Next\n`
    + (one
      ? `--center "${rows[0].file}#${rows[0].symbol}"\n`
      : `Pick one, then pass it as --center "<file>#<symbol>". Non-test definitions are listed first;\n`
        + `a same-named symbol in another file is a DIFFERENT thing, so the choice is yours to make.\n`));
  return 0;
}
