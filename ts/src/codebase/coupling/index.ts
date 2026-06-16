// SHARED-KEY coupling ENGINE — the framework- and language-agnostic core. Two front-ends feed it:
//   • the deterministic FLOOR — framework adapters (./adapters), each delegating syntax to a language
//     provider (core/resolve/languages); and
//   • tier-3 LLM (llm_discovery.discover_keys) — proposes keys cross-framework that ground HERE.
// The reusable piece is `shared_key_index`: a repo-wide map of who PRODUCES vs CONSUMES each key. A
// key the anchor produces surfaces its consumers; one it consumes surfaces its producers (so a writer
// reaches the UI that reads it, and a reader reaches the backend that wrote it). Edges are
// RESOLVED_PARTIAL crossings — pruned by the relevance pass, never asserted as a hard call.
import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { type Ctx, makeCtx, available, lang_for, _FUNCLIKE, _CLASS_KINDS, _METHOD_KINDS, _NAME_KINDS } from "../atoms.js";
import { endsWithSourceExt, SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { normpath, walk } from "../../core/resolve/walk.js";
import type { Access, ProposedKey } from "./types.js";
import { kindOf, scan_file_keys } from "./adapters/index.js";

export type { KeyHit, KeyKind, Access, ProposedKey } from "./types.js";
export { ADAPTERS, KEY_EDGE_KINDS, KEY_NODE_KINDS, DOMAIN_SUBJECT_KINDS, KEY_PRODUCE_EDGE_KINDS, scan_file_keys } from "./adapters/index.js";

const READER_CAP = 6;                          // materialise at most this many complement nodes per key
const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };
const ikey = (kind: string, value: string) => `${kind} ${value}`;

// ---- the repo-wide grounding index: `${kind} ${value}` → who produces / consumes it ----------
type KeyIndex = Map<string, { producers: Access[]; consumers: Access[] }>;
const _CACHE = new Map<string, KeyIndex>();

export function shared_key_index(repo: string, skipDirs: Set<string>): KeyIndex {
  if (_CACHE.has(repo)) return _CACHE.get(repo)!;
  const idx: KeyIndex = new Map();
  for (const [dir, files] of walk(repo, skipDirs)) {
    for (const fn of files) {
      if (!endsWithSourceExt(fn)) continue;
      let text: string;
      try { text = readFileSync(join(dir, fn), "utf-8"); } catch { continue; }
      const rel = relative(repo, join(dir, fn));
      const hits = scan_file_keys(rel, text);
      if (!hits.length) continue;
      for (const h of hits) {
        const k = ikey(h.kind, h.value);
        if (!idx.has(k)) idx.set(k, { producers: [], consumers: [] });
        (h.produces ? idx.get(k)!.producers : idx.get(k)!.consumers).push({ file: rel, line: h.line });
      }
    }
  }
  _CACHE.set(repo, idx);
  return idx;
}

function _name_of(ctx: Ctx, node: any): string | null {
  for (const c of ctx.children(node)) if (_NAME_KINDS.has(c.type)) return ctx.text(c);
  return null;
}

// The named function/method/class enclosing `line` in a complement file (smallest wins), or a module
// stub for a top-level access (e.g. a Next.js `export const GET = …` route). Lazy — only ≤CAP parsed.
export async function complement_unit(repo: string, file: string, line: number): Promise<{ symbol: string; kind: string; start: number; end: number }> {
  const fallback = { symbol: stem(file), kind: "module", start: line, end: line };
  const lang = lang_for(file);
  if (!lang || !available()) return fallback;
  let ctx: Ctx | null;
  try { ctx = await makeCtx(readFileSync(join(repo, file), "utf-8"), lang); } catch { return fallback; }
  if (!ctx) return fallback;
  let best: { symbol: string; kind: string; start: number; end: number } | null = null;
  for (const n of ctx.collect(ctx.root, (k) => _FUNCLIKE.has(k) || _CLASS_KINDS.has(k))) {
    const [s, e] = ctx.span(n);
    if (s > line || line > e) continue;
    const nm = _name_of(ctx, n);
    if (!nm) continue;
    if (!best || (e - s) < (best.end - best.start)) {
      best = { symbol: nm, kind: _CLASS_KINDS.has(n.type) ? "class" : _METHOD_KINDS.has(n.type) ? "method" : "function", start: s, end: e };
    }
  }
  return best ?? fallback;
}

const CHAIN_DEPTH = 1;   // chain the data-flow boundary this many hops past the anchor (db-table reader → ITS http-route)

// Attach the shared-key boundaries for the anchor: for each key it PRODUCES surface the consumers, for
// each it CONSUMES surface the producers — as a boundary node + (capped) crossing fan. Keys come from
// the deterministic scan of the anchor body AND from `proposed` (the LLM, cross-framework). A proposed
// key the index can't ground → a SUGGESTED blindspot (an LLM hypothesis, not a materialised node).
//
// TRANSITIVE: a complement is often itself a boundary onto the NEXT rung — a `payments` reader is an API
// route handler that SERVES an http-route the UI fetches. Without chaining, that second hop only appears
// if the LLM grow happens to re-anchor on a generically-named `GET` node (unreliable). So we recurse one
// hop into each materialised complement, scanning ITS body for further keys — `seenKeys` carries the
// boundaries an ancestor already surfaced so the chain can't loop back through the table it came in on.
// Mutates nodes/edges/blindspots; returns the new id counter. Self-gating: no keys → no-op.
export async function attach(repo: string, anchorId: string, anchorFile: string, anchorText: string,
    lo: number, hi: number, nodes: any[], edges: any[], blindspots: any[], counter: number, proposed: ProposedKey[] = [],
    depth = CHAIN_DEPTH, seenKeys: Set<string> = new Set()): Promise<number> {
  if (!available()) return counter;
  type Acc = { kind: string; value: string; produces: boolean; line: number; fromScan: boolean };
  const accs = new Map<string, Acc>();
  for (const h of scan_file_keys(anchorFile, anchorText)) {
    if (h.line < lo || h.line > hi) continue;
    const k = `${h.kind} ${h.value} ${h.produces}`;
    if (!accs.has(k) || h.line < accs.get(k)!.line) accs.set(k, { kind: h.kind, value: h.value, produces: h.produces, line: h.line, fromScan: true });
  }
  for (const p of proposed) {
    const k = `${p.kind} ${p.value} ${p.produces}`;
    if (!accs.has(k)) accs.set(k, { kind: p.kind, value: p.value, produces: p.produces, line: lo, fromScan: false });
  }
  if (!accs.size) return counter;
  const index = shared_key_index(repo, SKIP_DIRS);
  const anchorNorm = normpath(anchorFile);
  const boundaryOf = new Map<string, string>();   // `${kind} ${value}` → boundary node id (one per key)
  const surfaced = new Set(seenKeys);             // ancestor keys + the ones THIS call surfaces (fed to the chain recursion)

  // RELEVANCE prior for the capped fan: a complement that sits on the OTHER side of SEVERAL of the
  // anchor's keys is coupled through more than one data channel, so it's on-intent (e.g. a file that
  // writes BOTH `payments` and `members` in the payment flow); one sharing only a hub key (`members`)
  // is generic noise. Score = number of distinct anchor keys whose complement side names the file.
  // Cheap & deterministic — reuses the index already built; demotes hub-table crowds below the cap.
  const coFile = new Map<string, number>();
  for (const a of accs.values()) {
    const e = index.get(ikey(a.kind, a.value));
    const seen = new Set<string>();
    for (const c of (a.produces ? e?.consumers : e?.producers) ?? []) {
      if (normpath(c.file) === anchorNorm || seen.has(c.file)) continue;
      seen.add(c.file);
      coFile.set(c.file, (coFile.get(c.file) ?? 0) + 1);
    }
  }

  for (const a of [...accs.values()].sort((x, y) => (x.value < y.value ? -1 : x.value > y.value ? 1 : 0))) {
    if (seenKeys.has(ikey(a.kind, a.value))) continue;   // an ancestor already surfaced this boundary — don't loop back
    const kk = kindOf(a.kind);
    const entry = index.get(ikey(a.kind, a.value));
    const side = a.produces ? entry?.consumers : entry?.producers;   // the OTHER side
    const complementProduces = !a.produces;
    const byFile = new Map<string, number>();
    for (const c of side ?? []) { if (normpath(c.file) === anchorNorm) continue; if (!byFile.has(c.file) || c.line < byFile.get(c.file)!) byFile.set(c.file, c.line); }

    if (!byFile.size) {
      if (!a.fromScan) blindspots.push({ node: anchorId, mechanism: "llm-proposed-key",
        evidence: `LLM proposes a ${a.kind} coupling on '${a.value}' (${a.produces ? "produced" : "consumed"} here) the deterministic scan didn't index`, candidates: [] });
      continue;
    }
    let tid = boundaryOf.get(ikey(a.kind, a.value));
    if (tid === undefined) {
      counter += 1; tid = `dc${counter}`;
      boundaryOf.set(ikey(a.kind, a.value), tid);
      nodes.push({ id: tid, symbol: a.value, kind: kk.nodeKind, file: anchorFile, range: [a.line, a.line], enclosing: "", complexity: 1, coupling: true });
    }
    surfaced.add(ikey(a.kind, a.value));   // mark before recursing so a complement reading this same key skips it
    edges.push({ from: anchorId, to: tid, kind: a.produces ? kk.produceEdge : kk.consumeEdge, provenance: "RESOLVED_PARTIAL", line: a.line });
    const complements = [...byFile.entries()].sort((x, y) => {
      const sx = coFile.get(x[0]) ?? 0, sy = coFile.get(y[0]) ?? 0;
      if (sx !== sy) return sy - sx;   // higher cross-key co-occurrence first (relevance-ranked cap)
      return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1];   // then stable file/line
    });
    for (const [file, line] of complements.slice(0, READER_CAP)) {
      const u = await complement_unit(repo, file, line);
      counter += 1;
      const cid = `dc${counter}`;
      nodes.push({ id: cid, symbol: u.symbol, kind: u.kind, file, range: [u.start, u.end], enclosing: "", complexity: Math.max(1, u.end - u.start + 1), coupling: true });
      edges.push({ from: tid, to: cid, kind: complementProduces ? kk.produceEdge : kk.consumeEdge, provenance: "RESOLVED_PARTIAL" });
      // CHAIN: this complement may itself sit on the next boundary (the route handler that SERVES what the
      // UI fetches). Recurse one hop into its body, scanning ITS keys — `surfaced` blocks the table it reads.
      if (depth > 0) {
        let ctext = "";
        try { ctext = readFileSync(join(repo, file), "utf-8"); } catch { /* unreadable complement → no chain */ }
        if (ctext) counter = await attach(repo, cid, file, ctext, u.start, u.end, nodes, edges, blindspots, counter, [], depth - 1, surfaced);
      }
    }
    if (complements.length > READER_CAP) {
      blindspots.push({ node: tid, mechanism: "shared-key-fanout",
        evidence: `'${a.value}' (${a.kind}) is ${complementProduces ? "written" : "read"} in ${complements.length} files (showing ${READER_CAP}) — a data-flow boundary, not a call`,
        candidates: complements.slice(READER_CAP).map(([file]) => ({ file, symbol: a.value, provenance: "SUGGESTED" })) });
    }
  }
  return counter;
}
