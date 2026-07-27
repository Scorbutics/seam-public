// SCAN phase — the shared OVERLAY helpers every footprint builder runs after its core consumer/dependency
// pass: the depth-2 environment ripple, the UI route-chain (the final import hop a key-coupling chain
// can't carry), and the annotation key-window widening. Pulled out of the builders so the four anchor
// paths share one implementation.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { _resolve_import, scan_consumers, _kind_for, fileImporters } from "../../core/resolve/consumers.js";
import { endsWithSourceExt, parse_imports, SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { normpath, walk } from "../../core/resolve/walk.js";
import { recordRead, recordQuery, taint } from "../../core/resolve/dep_recorder.js";
import { makeCtx, available } from "../atoms.js";
import { _read, _named_units, _usage_lines, _enclosing, _enclosingClass, _exported_members, stem } from "../ast_units.js";
import { SCAN } from "./config.js";
import type { GraphNode, GraphEdge } from "./graph.js";

// A route/entry annotation (`@WebServlet("/x")`, `@GetMapping("/x")`, a decorator) sits on the line(s)
// ABOVE the class/method it decorates — often outside the def's own range, so an anchored handler's
// route key would be missed. Widen the key-scan window UP over contiguous leading `@…`/blank lines.
// Agnostic (any annotation/decorator); window-ONLY (does not change the node's reported range), and a
// no-op when there are no leading annotations — so annotation-free anchors are unaffected.
export function _annotationLo(text: string, lo: number): number {
  const lines = text.split("\n");
  // Clamp to the file's last line: a node's `lo` can point PAST the end of the text we re-read (a stale/
  // mismatched range after an edit, or a coupling probe on a file whose ranges came from a different read).
  // Without this bound `lines[lo-1]` is `undefined` and `.trim()` throws — silently killing the whole grow.
  let i = Math.min(lo - 1, lines.length - 1);
  while (i >= 0 && ((lines[i] ?? "").trim() === "" || (lines[i] ?? "").trim().startsWith("@"))) i--;
  return Math.max(0, i + 1);
}

// The environment ripple (depth-2 = the boundary frontier): for each depth-1 consumer that is an
// EXPORTED symbol, find ITS importers and wire them in (role=environment downstream). Port of
// _depth2_ripple. Returns [newNodes, newEdges, counter].
export async function _depth2_ripple(repo: string, consumers: GraphNode[], counter: number, seenKeys: Map<string, string>): Promise<[GraphNode[], GraphEdge[], number]> {
  const targets = new Map<string, string>(); // `${symbol} ${normFile}` → consumer node id
  for (const n of consumers) {
    if (n.kind === "module") continue;
    const rd = _read(repo, n.file);
    if (!rd) continue;
    const ctx = await makeCtx(rd[0], rd[1]);
    if (!ctx) continue;
    if (new Set(_exported_members(ctx).map((m) => m[0])).has(n.symbol)) targets.set(`${n.symbol} ${normpath(n.file)}`, n.id);
  }
  if (!targets.size) return [[], [], counter];
  const targetSyms = new Set([...targets.keys()].map((k) => k.split(" ")[0]));
  // REVERSE-INDEX CANDIDATES (SEAM_RIPPLE_INDEX, ON by default; =0 kill-switch → the old full walk) — the
  // depth-2 ripple below re-reads + text-scans EVERY repo source file to find who imports a target consumer.
  // That whole-repo walk was the dominant cost of a cold structural UP-grow (measured on cal.com: up-resolution
  // is 100–1000× the down side, ~O(moves × repo) — the walk alone was 76s → 3.5s once replaced, 21×). The
  // reverse-import index (`fileImporters`, built once + cached) already maps target-file → its importer files, so
  // we SKIP the read+scan for any file that imports NO target. SAFE BY CONSTRUCTION: `fileImporters` is a
  // file-level SUPERSET of the walk's importers, the inner parse_imports below still does the exact symbol match
  // (so extra candidates are filtered), and the walk order is preserved (only the read is gated) → `n${counter}`
  // ids and the whole node set are BYTE-IDENTICAL to the full walk. Validated: W8 node-set identical, the full
  // suite passes with it on AND off (1150 tests, incl. Java/Ruby/C/C++ fixtures), + a hermetic ripple test.
  let candidates: Set<string> | null = null;
  if (process.env.SEAM_RIPPLE_INDEX !== "0") {
    const importers = await fileImporters(repo);
    candidates = new Set<string>();
    for (const k of targets.keys()) {
      const tf = k.slice(k.indexOf(" ") + 1);
      const imps = importers.get(tf) ?? [];
      recordQuery("file-importers", [tf], [...imps]);   // open-set: a NEW importer of a rippled target invalidates
      for (const imp of imps) candidates.add(imp);
    }
  } else taint();   // SEAM_RIPPLE_INDEX=0 does a whole-repo walk-read → not per-file expressible; fall back to the epoch
  const newNodes: GraphNode[] = [], newEdges: GraphEdge[] = [];
  for (const [dir, files] of walk(repo, SKIP_DIRS)) {
    for (const fn of files) {
      if (!endsWithSourceExt(fn)) continue;
      const path = join(dir, fn);
      const rel = relative(repo, path);
      if (candidates && !candidates.has(normpath(rel))) continue;   // reverse-index says this file imports no target → skip the read+scan
      let text: string;
      try { text = readFileSync(path, "utf-8"); recordRead(rel, text); } catch { continue; }
      if (![...targetSyms].some((s) => text.includes(s))) continue;
      const hits = new Map<string, string>(); // target consumer node id → local
      for (const ref of parse_imports(rel, text)) {
        const target = await _resolve_import(repo, rel, ref);
        if (target === null || target[0] === null) continue;
        const tid = targets.get(`${ref.name} ${normpath(target[0])}`);
        if (tid) hits.set(tid, ref.local);
      }
      if (!hits.size) continue;
      const rd = _read(repo, rel);
      if (!rd) continue;
      const cctx = await makeCtx(rd[0], rd[1]);
      if (!cctx) continue;
      const units = _named_units(cctx);
      for (const [tid, local] of hits) {
        const line = _usage_lines(cctx, units, local)[0] ?? 0;
        const enc = _enclosing(units, line);
        const [name, kind, start, end] = enc ? enc : [stem(rel), "module", line, line];
        const key = `${rel}#${name}#${start}`;
        let d2id = seenKeys.get(key);
        if (d2id === undefined) {
          counter += 1;
          d2id = `n${counter}`;
          seenKeys.set(key, d2id);
          newNodes.push({ id: d2id, symbol: name, kind: _kind_for(rel, kind), file: rel, range: [start, end], enclosing: _enclosingClass(units, start, end), complexity: Math.max(1, end - start + 1) });
        }
        if (d2id !== tid) newEdges.push({ from: d2id, to: tid, kind: "reference", provenance: "RESOLVED_FULL" });
      }
    }
  }
  return [newNodes, newEdges, counter];
}

// CHAIN the final UI hop. A route-fetch caller (a service that `fetch`es a route) is itself imported BY
// the page/component that renders the data — an IMPORT edge the key-coupling chain can't carry. So after
// attach surfaces the callers, take that last import hop to the actual screen: a backend writer's
// footprint reaches the UI, not just the data layer. Bounded (`_UI_CAP`) + tagged `coupling:true` so the
// orchestrator's broadness cap doesn't skip the move (same rationale as the data-coupling fan).
const _UI_CAP = SCAN.uiCap;
export async function _chain_route_consumers(repo: string, nodes: GraphNode[], edges: GraphEdge[], counter: number): Promise<number> {
  if (!available()) return counter;
  const callerIds = new Set<string>();
  for (const e of edges) if (e.kind === "route-fetch") callerIds.add(e.to);
  if (!callerIds.size) return counter;
  const seen = new Set<string>(nodes.map((n) => `${n.file}#${n.symbol}#${(n.range ?? [0])[0]}`));
  for (const cid of callerIds) {
    const caller = nodes.find((n) => n.id === cid);
    if (!caller) continue;
    let added = 0;
    for (const con of await scan_consumers(repo, caller.file, caller.symbol)) {
      if (con.status !== "RESOLVED_FULL") continue;       // only real import resolutions reach the UI node
      const rd = _read(repo, con.file);
      if (!rd) continue;
      const cctx = await makeCtx(rd[0], rd[1]);
      if (!cctx) continue;
      const units = _named_units(cctx);
      let lines = _usage_lines(cctx, units, con.local);
      if (!lines.length) lines = [0];
      for (const ln of lines) {
        const enc = _enclosing(units, ln);
        let name: string, kind: string, start: number, end: number, cls: string;
        if (enc) { [name, kind, start, end] = enc; cls = _enclosingClass(units, start, end); }
        else { name = stem(con.file); kind = "module"; start = ln; end = ln; cls = ""; }
        const key = `${con.file}#${name}#${start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        counter += 1;
        const pid = `dc${counter}`;
        nodes.push({ id: pid, symbol: name, kind: _kind_for(con.file, kind), file: con.file, range: [start, end], enclosing: cls, complexity: Math.max(1, end - start + 1), coupling: true });
        edges.push({ from: pid, to: cid, kind: "reference", provenance: "RESOLVED_FULL" });
        if (++added >= _UI_CAP) break;
      }
      if (added >= _UI_CAP) break;
    }
  }
  return counter;
}
