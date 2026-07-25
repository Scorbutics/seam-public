// Port of src/core/resolve/languages/base.py — the language-provider substrate. Each language
// exposes a LanguageProvider: extensions, an optional deterministic FLOOR resolver, an optional
// import parser. The generic core only touches a provider through the registry (./index.ts).
import { statSync } from "node:fs";
import { sep, delimiter as pathSep } from "node:path";

export const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", ".turbo", "coverage", ".venv", "out",
  "target", "vendor", ".gradle", "__pycache__", ".yarn",
]);

// One query-builder TABLE access — `client.from('table').verb(...)` — the SYNTACTIC shape in a given
// language (the verb is the raw chained method). LANGUAGE-specific (how the chain is written); a
// FRAMEWORK adapter (codebase/coupling/adapters) decides which verbs are writes vs reads.
export interface TableAccess { table: string; verb: string; line: number }

// One imported symbol — the uniform unit the generic scan consumes. `source` set ⇒ resolve the
// MODULE path (TS); `source` null ⇒ resolve the SYMBOL at (line,col) via the LSP (Python).
export interface ImportRef {
  name: string;          // the imported symbol's ORIGINAL name
  local: string;         // its local binding (after `as`)
  line: number;          // 0-based line
  col: number;
  source: string | null; // the module string, or null
  reexport?: boolean;    // `export { X } from '...'` — a barrel hop, not a use; followed transitively
}

// A namespace import: `import * as X from "m"` / `const X = await import("m")` — binds the WHOLE module
// `m` under `local`, so a symbol it provides is used as `local.symbol`. Kept OUT of ImportRef (which the
// dependency graph + barrel walk consume by symbol name) and surfaced separately, used only by the
// consumer member-access scan — so adding it can't perturb dependency-direction footprints / oracles.
export interface NamespaceImport { local: string; source: string; line: number }

// A default import: `import X from "m"` (or `import X, { … } from "m"`) — binds module `m`'s DEFAULT
// export under the ARBITRARY local name `local`. It can't be matched by symbol name (the binding is the
// importer's choice), so it's surfaced separately and matched by MODULE — a consumer iff the anchor
// symbol is that module's default export. Same OUT-of-ImportRef rationale as NamespaceImport.
export interface DefaultImport { local: string; source: string; line: number }

// How to launch + drive a language's LSP server. Pure config — no resolution logic. Port of the
// base.py ServerSpec. `command(repo)` → argv | null (null ⇒ server unobtainable on this machine);
// `languageId` is a string, or (file)→string when a stack has per-file ids (tsx/jsx).
export interface ServerSpec {
  language: string;
  command: (repo: string) => string[] | null;
  languageId: string | ((file: string) => string);
  rootMarkers?: string[];
  initOptions?: (repo: string) => Record<string, unknown>;
  status?: string;
  notes?: string;
}

export interface LanguageProvider {
  name: string;
  extensions: string[];
  // deterministic FLOOR resolver: (repo, importingFile, source) -> repo-relative file | null.
  resolve?: (repo: string, importingFile: string, source: string) => string | null;
  // the file's import statements → ImportRef[].
  imports?: (text: string) => ImportRef[];
  // the file's NAMESPACE imports (`import * as X` / `const X = await import(...)`) → NamespaceImport[].
  // Only languages with namespace-member access (TS/JS) implement it; the consumer scan uses it to
  // attribute `X.symbol` member calls. [] / undefined ⇒ the language has no such form.
  namespaceImports?: (text: string) => NamespaceImport[];
  // the file's DEFAULT imports (`import X from "m"`) → DefaultImport[]. TS/JS only; matched by module
  // (not name) against a default-exported anchor. [] / undefined ⇒ the language has no default exports.
  defaultImports?: (text: string) => DefaultImport[];
  // the module's DEFAULT export SLOT → `{local, expr}`: the local declaration that FILLS the slot (null when
  // unprovable) and the raw slot expression (null when the module has no default export). A default import
  // binds the SLOT, not a name, so this is the only grounded way to attribute default-import consumers to a
  // member — including the wrapper form `export default withReporting(fn, "fn")`, whose slot resolves to `fn`.
  // undefined ⇒ the language has no default-export concept (Java/Python/Ruby/C/C++).
  defaultExport?: (text: string) => { local: string | null; expr: string | null };
  // query-builder table accesses (`.from('t').verb`) in THIS language's syntax → raw {table, verb, line}.
  // The verb classification (write vs read) is the framework adapter's job, not the language's.
  tableAccess?: (text: string) => TableAccess[];
  moduleEntry?: RegExp;  // basename regex marking a module entry (TS index.*, Python __init__.py)
  // CHEAP textual pre-gate for the interface→impl (DI) index parse: the tokens whose PRESENCE is necessary
  // for a file to declare an interface or an `implements` clause in THIS language. A file containing none
  // cannot contribute, so it is skipped BEFORE the (expensive) tree-sitter parse. `["interface","implements"]`
  // for Java/TS; `[]` for languages with NO interface→impl concept (Python/Ruby) ⇒ skip ALL their files;
  // `undefined` ⇒ unknown, parse to be safe. SOUND: an actual interface_declaration/implements_clause is
  // impossible without the keyword textually present, so the gate never drops a real impl edge.
  implMarkers?: string[];
  // the MAIN-entry line inside a module entry (ctx = an atoms Ctx, duck-typed). null ⇒ can't decide.
  entrypoint?: (ctx: any) => number | null;
  lsp?: ServerSpec;      // how to launch the language's LSP server (undefined ⇒ no server, floor only)
  // basename regex marking a route/handler/controller file BY THIS LANGUAGE's convention (Rails
  // `_controller.rb`, a Java `*Resource.java`, …) — the recall net coupling's L3 gate uses across all
  // languages. undefined ⇒ this language has no such convention (or isn't registered here yet).
  handlerFileConvention?: RegExp;
  // true ⇒ this language's coupling is carried by the tree-sitter CARRIER engine (a data-file/DSL walk)
  // rather than the span-local key matcher — currently Ruby only. undefined/false ⇒ matcher-only.
  carrierEngine?: boolean;
  // true ⇒ the regex def-extractor (defs_in_file) is the VALIDATED path for this language; other
  // languages fall back to the language-agnostic tree-sitter extractor. Currently TS/JS only.
  regexDefsValidated?: boolean;
  // consumer FEEDS a caller binds into a JSX-style tag matching the anchor (`<Anchor prop={value} />` ->
  // {prop: [{value, line}]}), from a pre-built parse ctx (duck-typed, like `entrypoint` above — atoms owns
  // parsing, the language module owns the tree-walk). Currently TS/JS (JSX) only; other languages have no
  // such attribute-binding form. undefined ⇒ no feeds for this language.
  consumerFeeds?: (ctx: any, anchorName: string) => Record<string, any[]>;
  // the interface named by a class-LITERAL argument in a call's arg-list text (Java `X.class`, the
  // grounding for a service-locator DI lookup — `getProvider(X.class)`). null ⇒ no class literal in the
  // text. undefined ⇒ this language has no such reflection-literal form (TS/Ruby/Python).
  classLiteralArg?: (argsText: string) => string | null;
  // true ⇒ this language marks its module boundary with an EXPORT STATEMENT (TS/JS). Languages without one
  // (Java/C/C++/Ruby/Python) express visibility with MODIFIERS instead, so their public surface is the file's
  // top-level type declarations + members — asking them for `export_statement` nodes finds nothing and makes
  // every module shape (contract) report "no exported members". undefined/false ⇒ exportless.
  exportStatements?: boolean;
  // The node KIND(s) that denote the ENCLOSING INSTANCE as a receiver — TS/Java/C++ `this`, Ruby `self`. A
  // member access on one of these (`this.m()`, `this.m` passed as a callback, `this.m.bind(this)`) names a
  // member of a KNOWN class (the enclosing one), so it resolves to a definite declaration without any
  // repo-wide name match. undefined ⇒ the language has no such distinct receiver node (Python's `self` is an
  // ordinary parameter identifier, indistinguishable from any other local) ⇒ no self-member edges there.
  selfReceiver?: string[];
}

// Locate a binary on PATH (the sync `shutil.which` equivalent). Returns the absolute path or null.
export function which(binary: string): string | null {
  for (const d of (process.env.PATH ?? "").split(pathSep)) {
    if (!d) continue;
    const cand = d.endsWith(sep) ? d + binary : d + sep + binary;
    try { if (statSync(cand).isFile()) return cand; } catch { /* keep looking */ }
  }
  return null;
}

function bunBin(): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home) { const installed = `${home}${sep}.bun${sep}bin${sep}bun`; try { if (statSync(installed).isFile()) return installed; } catch { /* fall through */ } }
  return which("bun");
}

// An npm-distributed server, fetched/run via bun (no global install). null if bun is absent.
export function bun_x(...pkgArgs: string[]): (repo: string) => string[] | null {
  return () => { const bun = bunBin(); return bun ? [bun, "x", ...pkgArgs] : null; };
}

// A server expected on PATH (system install). null if absent → that language degrades to floor.
export function system(binary: string, ...rest: string[]): (repo: string) => string[] | null {
  return () => { const b = which(binary); return b ? [b, ...rest] : null; };
}
