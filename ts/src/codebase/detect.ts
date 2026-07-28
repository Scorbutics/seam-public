// detect_* (C3) — the repo + tree-sitter detection passes over a confirmed anchor: a string-path dynamic
// import (a blind spot the reference resolver can't see), subcores (a god-object anchor's internal cliques),
// its member contract, and consumer FEEDS (what a consumer binds into the anchor's parameters). Moved out of
// codebase.ts (the anchor-relative assembly core) — this is scan-phase work over source text/AST, not seam
// assembly, matching the anchor/scan/grow/coupling phase-folder split the rest of codebase/ already uses.
import { readFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { type Edge, type Graph } from "../core/graph_ir.js";
import { walk as repoWalk } from "../core/resolve/walk.js";
import * as atoms from "./atoms.js";
import { RENDER } from "./config.js";
import { EXTENSIONS as _TS_EXT } from "../languages/typescript/dispatch.js";

const stemOf = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

// TODO this constant should be into a JS/TS specific scan module
const _DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
// `import()` is a JS/TS-only construct, so this scan is genuinely TS-only (unlike the generic repo walks
// elsewhere in this file) — sourced from the TS provider's own extension list rather than a hand-kept copy,
// so it can't silently drift the way this list once did (it was missing .mts/.cts until this fix).
const _SCAN_EXT = _TS_EXT;
const _CB_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "out", ".turbo", "coverage", ".cache", "vendor"]);
const _BLINDSPOT_CAP = RENDER.blindspotCap;
const np = (p: string) => { const n = normalize(p); return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n; };

// Layer 2: consumers that load the anchor via a STRING-PATH dynamic import — a text scan (no
// tree-sitter), surfaced as a SUGGESTED blind spot (never a resolved edge).
//
// TODO: this dynamic import scan is specifically for JS/TS (the only languages that have a string-path `import()` construct)
// It should probably be moved into a language-specific scan module
// A string-literal `import("./x")` resolves like a static import (languages/typescript/resolve.ts's
// `_DYNIMPORT_RE`/`imports()` already does this for the `const {a} = await import("literal")` shape,
// the one this text scan itself matches via `_DYNAMIC_IMPORT_RE`'s required quotes) — so a file that
// dynamic-imports the anchor is frequently ALREADY a resolved consumer in `g.edges`. Reporting it
// again here as an unresolved "can't see this" blindspot would contradict the graph's own resolved
// edge. Deduce from the grounded fact instead of re-guessing: skip any candidate file that already
// has a RESOLVED edge into the anchor; only the genuinely-unresolved residue is a real blindspot.
export function detect_dynamic_import_blindspots(g: Graph, repo: string): void {
  if (!g.anchor || !g.nodes.has(g.anchor) || !repo) return;
  const anchorFile = g.nodes.get(g.anchor)!.file;
  const stem = anchorFile ? stemOf(anchorFile) : "";
  if (!stem) return;
  const anchorAbs = np(join(repo, anchorFile));
  const resolvedFiles = new Set(g.edgesQuery({ dst: g.anchor }).map((e) => g.nodes.get(e.src)?.file).filter(Boolean));
  const candidates: Edge[] = [];
  outer: for (const [dir, files] of repoWalk(repo, _CB_SKIP)) {
    for (const fn of files) {
      if (!_SCAN_EXT.some((e) => fn.endsWith(e))) continue;
      const fpath = join(dir, fn);
      if (np(fpath) === anchorAbs) continue;
      const rel = np(fpath).startsWith(np(repo) + "/") ? np(fpath).slice(np(repo).length + 1) : np(fpath);
      if (resolvedFiles.has(rel)) continue;
      let text: string;
      try { text = readFileSync(fpath, "utf-8"); } catch { continue; }
      if (!text.includes("import(") || !text.includes(stem)) continue;
      text.split("\n").forEach((line, idx) => {
        if (!line.includes("import(")) return;
        for (const m of line.matchAll(_DYNAMIC_IMPORT_RE)) {
          if (stemOf(m[1]) === stem) {
            candidates.push({ src: g.anchor, dst: `${rel}:${idx + 1}`, kind: "dynamic-import", provenance: "SUGGESTED", line: 0 });
          }
        }
      });
      if (candidates.length >= _BLINDSPOT_CAP) break outer;
    }
  }
  if (candidates.length) {
    g.blindspots.push({ node: g.anchor, mechanism: "dynamic-import",
      evidence: `loaded via dynamic import in ${candidates.length} place(s) — a string-path load the reference resolver can't see`,
      candidates });
  }
}

// DOWNSTREAM dynamic-dispatch blindspot (the twin of the UP dynamic-import scan above): a footprint node whose
// body DISPATCHES OUT through a mechanism static resolution can't thread — so the flow continues into an impl (and
// its data sink) chosen at runtime, and the node renders as a dead-ending call step with no `──▶ sink`. Two shapes,
// both TS/JS-only and both purely SYNTACTIC (a code shape, not a name/meaning guess):
//   A. a DYNAMIC IMPORT of a non-literal: `await import(x)` where x is NOT a quoted string (a string literal is
//      statically resolvable and already followed) — the app-store `await paymentAppImportFn` pattern.
//   B. an IMPORTED REGISTRY indexed by a runtime key: `REG[key]` where REG is a module import and the key is not a
//      string literal — cal.com `PaymentServiceMap[key]` (a generated `*.services.generated` map). A local array
//      `arr[i]` is NOT imported, so it's excluded; a literal key `M["x"]` IS resolvable, so it's excluded.
// Emitted as `dynamic-dispatch` (the render's frontier-⟂/Blindspots already consumes that mechanism), naming the
// node + the dispatch so a reader knows the flow provably continues THERE — instead of silently dropping the sink.
const _DYN_IMPORT_NONLITERAL = /\bimport\(\s*[^'"\s)]/;
export function detect_dynamic_dispatch_blindspots(g: Graph, repo: string): void {
  if (!repo) return;
  const _BOUNDARY = new Set(["table", "db-table", "route", "queue", "topic", "event", "service", "cache", "file"]);
  const textCache = new Map<string, { lines: string[]; imports: Set<string> } | null>();
  const load = (rel: string) => {
    if (textCache.has(rel)) return textCache.get(rel)!;
    let text: string;
    try { text = readFileSync(join(repo, rel), "utf-8"); } catch { textCache.set(rel, null); return null; }
    const imports = new Set<string>();
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)) for (const p of m[1].split(",")) { const nm = p.trim().split(/\s+as\s+/).pop()!.trim(); if (/^\w+$/.test(nm)) imports.add(nm); }
    for (const m of text.matchAll(/import\s+(\w+)\s*(?:,|from)/g)) imports.add(m[1]);
    const rec = { lines: text.split("\n"), imports }; textCache.set(rel, rec); return rec;
  };
  let emitted = 0;
  const seen = new Set<string>();
  for (const n of g.nodes.values()) {
    if (emitted >= _BLINDSPOT_CAP) break;
    if (!n.file || (n as any).coupling || _BOUNDARY.has(n.kind) || !_SCAN_EXT.some((e) => n.file.endsWith(e))) continue;
    if (!(n.end > n.start)) continue;   // needs a real body span
    const key = `${n.file}#${n.start}`; if (seen.has(key)) continue; seen.add(key);
    const rec = load(n.file); if (!rec) continue;
    const body = rec.lines.slice(n.start, n.end + 1).join("\n");
    let evidence: string | null = null;
    if (_DYN_IMPORT_NONLITERAL.test(body)) evidence = "dynamic-imports a non-literal module path";
    else for (const ident of rec.imports) {
      // an imported registry subscripted by a runtime (non-literal) key whose RESULT is ACTIVATED as code — awaited,
      // called, constructed, or dynamically imported (directly, or via a `const X = REG[key]` binding then `await X`
      // / `X(` / `new X` / `import(X)`). The activation check is what separates a real service/module dispatch
      // (PaymentServiceMap[key] → await → .create) from a scalar ENUM/const lookup (`ErrorCode[key]`, a string) —
      // the latter has an identical subscript SHAPE but never resolves to an impl with a data sink, so it's not a
      // blindspot. Purely syntactic: `await`/`new`/`(`/`import(` on the subscript or its bound variable.
      const sub = `${ident}\\[\\s*[^\\]'"\\s][^\\]]*\\]`;   // REG[<non-literal key>]
      const direct = new RegExp(`(?:await\\s+|new\\s+|import\\(\\s*)${sub}|${sub}\\s*\\(`);
      const bind = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*${sub}`, "g");
      let hit = direct.test(body);
      if (!hit) for (const m of body.matchAll(bind)) { const v = m[1]; if (new RegExp(`(?:await\\s+${v}\\b|\\b${v}\\s*\\(|new\\s+${v}\\b|import\\(\\s*${v}\\b)`).test(body)) { hit = true; break; } }
      if (hit) { evidence = `dispatches through the imported registry \`${ident}[…]\``; break; }
    }
    if (!evidence) continue;
    g.blindspots.push({ node: n.id, mechanism: "dynamic-dispatch",
      evidence: `${n.label} ${evidence} — the concrete impl (and its data sink) is chosen at runtime; static resolution stops here`,
      candidates: [] });
    emitted++;
  }
}

const _isClassAnchor = (g: Graph): boolean => {
  const sym = g.nodes.get(g.anchor)!.label;
  return [...g.nodes.values()].some((n) => n.id !== g.anchor && n.enclosing === sym);
};
const readRepoFile = (repo: string, file: string): string | null => {
  try { return readFileSync(join(repo, file), "utf-8"); } catch { return null; }
};

export async function detect_subcores(g: Graph, repo: string): Promise<void> {
  if (!g.anchor || !g.nodes.has(g.anchor)) return;
  const node = g.nodes.get(g.anchor)!;
  if (_isClassAnchor(g)) return;
  const lang = atoms.lang_for(node.file);
  if (!lang) return;
  const content = readRepoFile(repo, node.file);
  if (content === null) return;
  // THE CLUSTERING IS THE CORE'S (`seam_lang::atoms::subcores`). It extracts the anchor's atoms, drops the
  // AMBIENT names — anything more than half of them mention, which is the function's own scaffolding and
  // would fuse every atom into one useless group — and unions what is left transitively. Rows arrive as
  // `[id, label, "s:e,s:e", read…]`; `proposed` is added here because it is a presentation fact (these are
  // suggestions for a reviewer, never resolved structure), not something the clustering decides.
  const rows = ((await import("./rust_core.js")).loadAddon()?.subcoresOf(content, lang, node.start, node.end) ?? []) as string[][];
  if (!rows.length) return;
  node.subcores = rows.map(([id, label, ranges, ...reads]) => ({
    id, label, reads,
    ranges: ranges ? ranges.split(",").map((r) => r.split(":").map(Number)) : [],
    proposed: true,
  }));
}

export async function detect_contract(g: Graph, repo: string): Promise<void> {
  if (!g.anchor || !g.nodes.has(g.anchor)) return;
  const node = g.nodes.get(g.anchor)!;
  if (_isClassAnchor(g)) return;
  const lang = atoms.lang_for(node.file);
  if (!lang) return;
  const content = readRepoFile(repo, node.file);
  if (content === null) return;
  const members = await atoms.extract_contract(content, lang, node.start, node.end);
  node.contract = members.map((m) => ({ name: m.name, role: m.invoked ? "link" : "environment", ranges: m.ranges.map((r) => [...r]), invoked: m.invoked }));
}

export async function detect_consumer_feeds(g: Graph, repo: string): Promise<void> {
  if (!g.anchor || !g.nodes.has(g.anchor)) return;
  const node = g.nodes.get(g.anchor)!;
  const byName = new Map<string, any>(node.contract.map((c: any) => [c.name, c]));
  if (!byName.size) return;
  const anchorName = node.label;
  const consumers = new Set(g.edgesQuery({ dst: g.anchor }).map((e) => e.src));
  const seen = new Set<string>();
  for (const cid of consumers) {
    const cn = g.nodes.get(cid);
    if (!cn || !cn.file || seen.has(cn.file)) continue;
    seen.add(cn.file);
    const lang = atoms.lang_for(cn.file);
    if (!lang) continue;
    const content = readRepoFile(repo, cn.file);
    if (content === null) continue;
    const fed = await atoms.extract_consumer_feeds(content, cn.file, anchorName);
    for (const [pname, binds] of Object.entries(fed)) {
      const member = byName.get(pname);
      if (!member) continue;
      for (const b of binds) {
        const feed: any = { from: cn.file, value: b.value, line: b.line };
        if ("valLine" in b) { feed.valLine = b.valLine; feed.valCol = b.valCol; }
        (member.feeds ??= []).push(feed);
      }
    }
  }
}
