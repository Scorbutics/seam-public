// detect_* (C3) — the repo + tree-sitter detection passes over a confirmed anchor: a string-path dynamic
// import (a blind spot the reference resolver can't see), subcores (a god-object anchor's internal cliques),
// its member contract, and consumer FEEDS (what a consumer binds into the anchor's parameters). Moved out of
// codebase.ts (the anchor-relative assembly core) — this is scan-phase work over source text/AST, not seam
// assembly, matching the anchor/scan/grow/coupling phase-folder split the rest of codebase/ already uses.
import { readFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { type Edge, type Graph, connected_components } from "../../core/graph_ir.js";
import { walk as repoWalk } from "../../core/resolve/walk.js";
import * as atoms from "../atoms.js";
import { RENDER } from "../config.js";

const stemOf = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

const _DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const _SCAN_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const _CB_SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "out", ".turbo", "coverage", ".cache", "vendor"]);
const _BLINDSPOT_CAP = RENDER.blindspotCap;
const np = (p: string) => { const n = normalize(p); return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n; };

// Layer 2: consumers that load the anchor via a STRING-PATH dynamic import — a text scan (no
// tree-sitter), surfaced as a SUGGESTED blind spot (never a resolved edge).
export function detect_dynamic_import_blindspots(g: Graph, repo: string): void {
  if (!g.anchor || !g.nodes.has(g.anchor) || !repo) return;
  const anchorFile = g.nodes.get(g.anchor)!.file;
  const stem = anchorFile ? stemOf(anchorFile) : "";
  if (!stem) return;
  const anchorAbs = np(join(repo, anchorFile));
  const candidates: Edge[] = [];
  outer: for (const [dir, files] of repoWalk(repo, _CB_SKIP)) {
    for (const fn of files) {
      if (!_SCAN_EXT.some((e) => fn.endsWith(e))) continue;
      const fpath = join(dir, fn);
      if (np(fpath) === anchorAbs) continue;
      let text: string;
      try { text = readFileSync(fpath, "utf-8"); } catch { continue; }
      if (!text.includes("import(") || !text.includes(stem)) continue;
      text.split("\n").forEach((line, idx) => {
        if (!line.includes("import(")) return;
        for (const m of line.matchAll(_DYNAMIC_IMPORT_RE)) {
          if (stemOf(m[1]) === stem) {
            const rel = np(fpath).startsWith(np(repo) + "/") ? np(fpath).slice(np(repo).length + 1) : np(fpath);
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
  const ats = await atoms.extract_atoms(content, lang, node.start, node.end);
  if (ats.length < 2) return;
  const cut = Math.max(1, Math.floor(ats.length / 2));
  const freq = new Map<string, number>();
  for (const a of ats) for (const n of a.names) freq.set(n, (freq.get(n) ?? 0) + 1);
  const ambient = new Set([...freq.entries()].filter(([, c]) => c > cut).map(([n]) => n));
  const ids = ats.map((_, i) => `${g.anchor}.b${i}`);
  const byName = new Map<string, string[]>();
  const edges: [string, string][] = [];
  ats.forEach((a, i) => { for (const name of a.names) if (!ambient.has(name)) { if (!byName.has(name)) byName.set(name, []); byName.get(name)!.push(ids[i]); } });
  for (const members of byName.values()) for (const x of members.slice(1)) edges.push([members[0], x]);
  const groups = connected_components(ids, edges);
  if (new Set(groups.values()).size < 2) return;
  const byGroup = new Map<string, number[]>();
  ats.forEach((_, i) => { const k = groups.get(ids[i])!; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k)!.push(i); });
  const subcores: any[] = [];
  for (const gid of [...byGroup.keys()].sort()) {
    const idxs = byGroup.get(gid)!;
    const ranges = idxs.map((i) => [ats[i].start, ats[i].end]);
    const reads = [...new Set(idxs.flatMap((i) => [...ats[i].names].filter((n) => !ambient.has(n))))].sort();
    subcores.push({ id: gid, label: reads.length ? reads[0] : gid, ranges, reads, proposed: true });
  }
  node.subcores = subcores;
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
  const consumers = new Set(g.edges.filter((e) => e.dst === g.anchor).map((e) => e.src));
  const seen = new Set<string>();
  for (const cid of consumers) {
    const cn = g.nodes.get(cid);
    if (!cn || !cn.file || seen.has(cn.file)) continue;
    seen.add(cn.file);
    const lang = atoms.lang_for(cn.file);
    if (!lang) continue;
    const content = readRepoFile(repo, cn.file);
    if (content === null) continue;
    const fed = await atoms.extract_consumer_feeds(content, lang, anchorName);
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
