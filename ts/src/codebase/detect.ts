// detect_* (C3) — the repo + tree-sitter detection passes over a confirmed anchor: a string-path dynamic
// import (a blind spot the reference resolver can't see), subcores (a god-object anchor's internal cliques),
// its member contract, and consumer FEEDS (what a consumer binds into the anchor's parameters). Moved out of
// codebase.ts (the anchor-relative assembly core) — this is scan-phase work over source text/AST, not seam
// assembly, matching the anchor/scan/grow/coupling phase-folder split the rest of codebase/ already uses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Edge, type Graph } from "../core/graph_ir.js";
import * as atoms from "./atoms.js";
import { loadAddon } from "./rust_core.js";
import { RENDER } from "./config.js";
import { EXTENSIONS as _TS_EXT } from "../languages/typescript/dispatch.js";


// `import()` is a JS/TS-only construct, so this scan is genuinely TS-only (unlike the generic repo walks
// elsewhere in this file) — sourced from the TS provider's own extension list rather than a hand-kept copy,
// so it can't silently drift the way this list once did (it was missing .mts/.cts until this fix).
const _SCAN_EXT = _TS_EXT;
const _BLINDSPOT_CAP = RENDER.blindspotCap;

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
  if (!anchorFile) return;
  // Files already RESOLVED into the anchor are excluded by the core. A literal `import("./x")` resolves like a
  // static import and the resolver already follows it, so reporting those again would contradict the graph's
  // own edge with a "cannot see this" claim — only the genuinely-unresolved residue is a blind spot.
  const resolved = [...new Set(g.edgesQuery({ dst: g.anchor }).map((e) => g.nodes.get(e.src)?.file).filter(Boolean))] as string[];
  const rows = (loadAddon()?.dynamicImportCandidates(repo, anchorFile, resolved, _BLINDSPOT_CAP) ?? []) as string[][];
  if (!rows.length) return;
  const candidates: Edge[] = rows.map(([rel, line]) => ({ src: g.anchor, dst: `${rel}:${line}`, kind: "dynamic-import", provenance: "SUGGESTED", line: 0 }));
  g.blindspots.push({ node: g.anchor, mechanism: "dynamic-import",
    evidence: `loaded via dynamic import in ${candidates.length} place(s) — a string-path load the reference resolver can't see`,
    candidates });
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
export function detect_dynamic_dispatch_blindspots(g: Graph, repo: string): void {
  if (!repo) return;
  const _BOUNDARY = new Set(["table", "db-table", "route", "queue", "topic", "event", "service", "cache", "file"]);
  const core = loadAddon();
  if (!core) return;
  const textCache = new Map<string, string[] | null>();
  const load = (rel: string): string[] | null => {
    if (textCache.has(rel)) return textCache.get(rel)!;
    let lines: string[] | null = null;
    try { lines = readFileSync(join(repo, rel), "utf-8").split("\n"); } catch { /* unreadable */ }
    textCache.set(rel, lines);
    return lines;
  };
  let emitted = 0;
  const seen = new Set<string>();
  for (const n of g.nodes.values()) {
    if (emitted >= _BLINDSPOT_CAP) break;
    if (!n.file || (n as any).coupling || _BOUNDARY.has(n.kind) || !_SCAN_EXT.some((e) => n.file.endsWith(e))) continue;
    if (!(n.end > n.start)) continue;   // needs a real body span
    const key = `${n.file}#${n.start}`; if (seen.has(key)) continue; seen.add(key);
    const lines = load(n.file); if (!lines) continue;
    // The core reads the FILE for its imports and the BODY for the dispatch shape — a registry subscript only
    // counts when its receiver came from another module, which the node's own span cannot tell you.
    const evidence = core.dynamicDispatchEvidence(lines.join("\n"), lines.slice(n.start, n.end + 1).join("\n")) as string;
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
  // `[name, invoked, "s:e,s:e"]` from the core. ROLE is decided here, not there: `invoked` is a structural
  // fact (the name is a call target) while link-vs-environment is this pass's reading of it.
  const rows = ((await import("./rust_core.js")).loadAddon()?.extractContract(content, lang, node.start, node.end) ?? []) as string[][];
  node.contract = rows.map(([name, invoked, ranges]) => ({
    name,
    role: invoked ? "link" : "environment",
    ranges: ranges ? ranges.split(",").map((r) => r.split(":").map(Number)) : [],
    invoked: Boolean(invoked),
  }));
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
    // `[prop, value, line, valLine, valCol]` from the core, in source order. A prop the anchor does not
    // declare is dropped: a feed is only meaningful against a contract member it binds to.
    const rows = ((await import("./rust_core.js")).loadAddon()?.extractConsumerFeeds(content, cn.file, anchorName) ?? []) as string[][];
    for (const [pname, value, line, valLine, valCol] of rows) {
      const member = byName.get(pname);
      if (!member) continue;
      const feed: any = { from: cn.file, value, line: Number(line) };
      // ABSENT, not zero — a bare attribute has no value expression to point at, and line 0 is a real line a
      // reader would be sent to wrongly.
      if (valLine !== "") { feed.valLine = Number(valLine); feed.valCol = Number(valCol); }
      (member.feeds ??= []).push(feed);
    }
  }
}
