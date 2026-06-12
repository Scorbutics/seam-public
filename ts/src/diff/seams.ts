// Port of src/diff/seams.py — seam-assembly engine: classified hunks → intent clusters → seams.
// Presentation-agnostic; consumed by emit_seams_json (the VS Code feed) and report_text.
import type { Hunk } from "./parser.js";
import { external_coupling, external_refs, rewire_pairs } from "./symbol_edges.js";
import { subgroup_seams } from "./subgroup.js";
import { consumers_for } from "./blast_radius.js";

const _CLUSTER_ROLES = ["core", "link", "environment"] as const;
export const UNCERTAIN_THRESHOLD = 0.6;

export interface Block {
  role: string; key: string; hid: string; file: string; start: number; end: number;
  has_diff: boolean; items: any[]; files: string[]; whys: string[]; notes: string[]; count: number;
}
export interface SeamDict {
  tested: boolean; untested: boolean; id: string; label: string; blocks: Block[];
  has_core: boolean; has_link: boolean; verification: any; count: number; link_ids: string[];
  uncertain: boolean; confidence: number; shares_with?: string[];
}
export interface ClusterDict {
  id: string; intent: string; seams: SeamDict[]; n_seams: number;
  role_pills: { role: string; count: number }[]; count: number; warnings: any[];
}

function _is_renderable(h: Hunk): boolean {
  return !h.is_binary && h.text.replace(/^\s+/, "").startsWith("@@");
}

function _merged_diff(hunks: Hunk[]): string {
  const by_file = new Map<string, Hunk[]>();
  const order: string[] = [];
  for (const h of hunks) {
    if (!_is_renderable(h)) continue;
    const sk = [h.source_file, h.target_file, h.file_path].join("|");
    if (!by_file.has(sk)) { by_file.set(sk, []); order.push(sk); }
    by_file.get(sk)!.push(h);
  }
  const chunks: string[] = [];
  for (const sk of order) {
    const fileHunks = by_file.get(sk)!;
    const first = fileHunks[0];
    const a = first.source_file || `a/${first.file_path}`;
    const b = first.target_file || `b/${first.file_path}`;
    const ga = a === "/dev/null" ? first.file_path : (a.startsWith("a/") ? a.slice(2) : a);
    const gb = b === "/dev/null" ? first.file_path : (b.startsWith("b/") ? b.slice(2) : b);
    chunks.push(`diff --git a/${ga} b/${gb}`, `--- ${a}`, `+++ ${b}`);
    for (const h of fileHunks) chunks.push(h.text.replace(/\n+$/, ""));
  }
  return chunks.length ? chunks.join("\n") + "\n" : "";
}

function _notes(hunks: Hunk[]): string[] {
  return hunks.filter((h) => !_is_renderable(h)).map((h) => `${h.id} · ${h.file_path}: ${h.text.trim()}`);
}

function _file_items(hunks: Hunk[]): any[] {
  const by_file = new Map<string, any>();
  const order: string[] = [];
  for (const h of hunks) {
    if (!by_file.has(h.file_path)) { by_file.set(h.file_path, { file: h.file_path, ids: [], rationales: [] }); order.push(h.file_path); }
    const it = by_file.get(h.file_path);
    it.ids.push(h.id);
    if (h.rationale && !it.rationales.includes(h.rationale)) it.rationales.push(h.rationale);
  }
  return order.map((f) => by_file.get(f));
}

export function _hunk_start_line(h: Hunk): number {
  const m = headerLine(h).match(/\+(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

export function _hunk_line_span(h: Hunk): [number, number] {
  const m = headerLine(h).match(/\+(\d+)(?:,(\d+))?/);
  if (!m) return [0, 0];
  const start = parseInt(m[1], 10);
  const count = m[2] ? parseInt(m[2], 10) : 1;
  return [start, start + Math.max(count, 1) - 1];
}

function headerLine(h: Hunk): string {
  return h.text ? h.text.split("\n")[0] : "";
}

function _span_map(hunks: Hunk[]): [Map<string, Map<string, [number, number]>>, Map<string, Map<string, [number, number]>>] {
  const link_spans = new Map<string, Map<string, [number, number]>>();
  const core_spans = new Map<string, Map<string, [number, number]>>();
  for (const h of hunks) for (const p of h.placements) {
    if (!p.seam) continue;
    const dst = h.role === "core" ? core_spans : link_spans;
    if (!dst.has(h.id)) dst.set(h.id, new Map());
    dst.get(h.id)!.set(p.seam, [p.start, p.end]);
  }
  return [link_spans, core_spans];
}

function _role_blocks(hunks: Hunk[], keyPrefix: string, diffs: Map<string, string>,
                      sid: string | null, span_map: Map<string, Map<string, [number, number]>> | null,
                      role_for: Map<string, string>, core_span_map: Map<string, Map<string, [number, number]>> | null): Block[] {
  role_for = role_for ?? new Map();
  const ordered = [...hunks].sort((a, b) =>
    a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : _hunk_start_line(a) - _hunk_start_line(b));
  const blocks: Block[] = [];
  for (const h of ordered) {
    const key = `${keyPrefix}-${h.id}`;
    const diffStr = _merged_diff([h]);
    if (diffStr.trim()) diffs.set(key, diffStr);
    const items = _file_items([h]);
    const whys: string[] = [];
    for (const it of items) for (const r of it.rationales) if (!whys.includes(r)) whys.push(r);
    const effRole = role_for.get(h.id) ?? h.role!;
    const mkBlock = (role: string, start: number, end: number, bkey: string): Block => ({
      role, key: bkey, hid: h.id, file: h.file_path, start, end, has_diff: !!diffStr.trim(),
      items, files: items.map((it: any) => it.file), whys, notes: _notes([h]), count: 1,
    });
    let span: [number, number] | undefined;
    if (sid) span = span_map?.get(h.id)?.get(sid) ?? core_span_map?.get(h.id)?.get(sid);
    if (span) { blocks.push(mkBlock(effRole, span[0], span[1], key)); continue; }
    const [fullStart, fullEnd] = _hunk_line_span(h);
    const peel = h.placements.find((p) => !p.seam);
    if (peel && (effRole === "core" || effRole === "link") && peel.end < fullEnd) {
      blocks.push(mkBlock("environment", peel.start, peel.end, `${key}-env`));
      blocks.push(mkBlock(effRole, peel.end + 1, fullEnd, key));
      continue;
    }
    blocks.push(mkBlock(effRole, fullStart, fullEnd, key));
  }
  return blocks;
}

function _verify_pair(hasCore: boolean, hasLink: boolean, corelessCluster = false): any {
  if (corelessCluster) {
    const posture = hasLink
      ? "link-only — no new logic in this diff; it wires a core that lives elsewhere (existing code, or another change). Verify the connection."
      : "ambient only — shared/support changes; trust delegated to the consumer";
    return { triangulated: false, link_only: true, posture, warnings: [] };
  }
  const warnings: any[] = [];
  if (hasCore && !hasLink)
    warnings.push({ kind: "isolated-core", text: "isolated core — no link in this seam; verify the consumer (may be in another seam/cluster or outside the diff)" });
  else if (hasLink && !hasCore)
    warnings.push({ kind: "dangling-link", text: "dangling link — no core in this seam; wires to something changed elsewhere" });
  else if (!hasCore && !hasLink)
    warnings.push({ kind: "delegated", text: "ambient only — no core/link; trust delegated to the consumer" });
  return { triangulated: hasCore && hasLink, warnings };
}

const _WARN_LABELS: Record<string, string> = {
  "isolated-core": "isolated core", "dangling-link": "dangling link", "delegated": "ambient only",
};

function _aggregate_warnings(kinds: Map<string, number>): any[] {
  const out: any[] = [];
  for (const [kind, label] of Object.entries(_WARN_LABELS)) {
    const n = kinds.get(kind) ?? 0;
    if (n) out.push({ kind, count: n, text: `${n} ${label}${n > 1 ? " seams" : " seam"}` });
  }
  return out;
}

// Seam-id ordering: by first \d+ run (missing → 1_000_000), tie-break by string.
function seamSortKey(s: string): [number, string] {
  const m = s.match(/\d+/);
  return [m ? parseInt(m[0], 10) : 1_000_000, s];
}

export function _build_clusters(hunks: Hunk[], repo?: string): [ClusterDict[], Map<string, string>] {
  const covered_seams = new Set<string>();
  for (const h of hunks) if (h.role === "test") for (const w of h.wires) covered_seams.add(w);
  const [span_map, core_span_map] = _span_map(hunks);
  const non_noise = hunks.filter((h) => h.role !== "noise" && h.role !== "test");
  const all_splittable = non_noise.filter((h) => h.role === "link" || h.role === "environment");
  const all_cores = non_noise.filter((h) => h.role === "core");

  const group_order: string[] = [];
  for (const h of non_noise) { const gid = h.group || "ungrouped"; if (!group_order.includes(gid)) group_order.push(gid); }

  const diffs = new Map<string, string>();
  const clusters: ClusterDict[] = [];
  for (const gid of group_order) {
    const members = non_noise.filter((h) => (h.group || "ungrouped") === gid);
    const intent = (members.find((h) => h.intent)?.intent || "") || "(unlabeled change)";
    const cores = members.filter((h) => h.role === "core");
    const links = members.filter((h) => h.role === "link");
    const envs = members.filter((h) => h.role === "environment");

    const seam_ids: string[] = [];
    for (const c of cores) { const sid = c.seam || "s0"; if (!seam_ids.includes(sid)) seam_ids.push(sid); }
    seam_ids.sort((a, b) => { const ka = seamSortKey(a), kb = seamSortKey(b); return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0); });
    const known = new Set(seam_ids);
    const coreless = cores.length === 0;

    type Spec = [string, string, Hunk[], string[], Map<string, string>];
    const specs: Spec[] = [];
    if (cores.length) {
      for (const sid of seam_ids) {
        const core_hunks = cores.filter((c) => (c.seam || "s0") === sid);
        const link_hunks = links.filter((l) => l.wires.includes(sid));
        const env_hunks = envs.filter((e) => e.wires.includes(sid));
        const role_for = new Map<string, string>();
        const here = new Set([...core_hunks, ...link_hunks, ...env_hunks].map((h) => h.id));
        for (const h2 of all_splittable) {
          if (!here.has(h2.id) && span_map.get(h2.id)?.has(sid)) {
            (h2.role === "link" ? link_hunks : env_hunks).push(h2);
            here.add(h2.id);
          }
        }
        for (const c2 of all_cores) {
          if (here.has(c2.id)) continue;
          if ((c2.seam || "s0") !== sid && core_span_map.get(c2.id)?.has(sid)) {
            link_hunks.push(c2);
            role_for.set(c2.id, "link");
            here.add(c2.id);
          }
        }
        const label = core_hunks.find((h) => h.seam_label)?.seam_label || "";
        specs.push([sid, label, [...core_hunks, ...link_hunks, ...env_hunks], link_hunks.map((l) => l.id), role_for]);
      }
      const dangling = links.filter((l) => !l.wires.some((s) => known.has(s)));
      if (dangling.length) specs.push(["s-unwired", "unwired links", dangling, dangling.map((l) => l.id), new Map()]);
      const ambient = envs.filter((e) => !e.wires.some((s) => known.has(s)));
      if (ambient.length) specs.push(["s-ambient", "ambient ripple", ambient, [], new Map()]);
    } else {
      const rest = [...links, ...envs];
      if (rest.length) {
        const seamLabelTxt = (intent && intent !== "(unlabeled change)") ? intent : (links.length ? "link-only changes" : "ambient changes");
        specs.push([links.length ? "s-rewire" : "s-ambient", seamLabelTxt, rest, links.map((l) => l.id), new Map()]);
      }
    }

    const seams: SeamDict[] = [];
    const cluster_kinds = new Map<string, number>();
    for (const [sid, label, seam_hunks, link_ids, role_for] of specs) {
      const blocks = _role_blocks(seam_hunks, `${gid}-${sid}`, diffs, sid, span_map, role_for, core_span_map);
      const sHasCore = blocks.some((b) => b.role === "core");
      const sHasLink = blocks.some((b) => b.role === "link");
      const verification = _verify_pair(sHasCore, sHasLink, coreless);
      for (const w of verification.warnings) cluster_kinds.set(w.kind, (cluster_kinds.get(w.kind) ?? 0) + 1);
      const seam_cores = seam_hunks.filter((h) => h.role === "core");
      const min_conf = seam_cores.length ? Math.min(...seam_cores.map((h) => h.role_confidence)) : 1.0;
      const uncertain = seam_cores.length > 0 && min_conf < UNCERTAIN_THRESHOLD;
      const tested = covered_seams.has(sid);
      const untested = sHasCore && !tested;
      seams.push({
        tested, untested, id: sid, label, blocks, has_core: sHasCore, has_link: sHasLink,
        verification, count: seam_hunks.length, link_ids, uncertain, confidence: Math.round(min_conf * 100) / 100,
      });
    }

    const link_to_seams = new Map<string, string[]>();
    for (const s of seams) for (const lid of s.link_ids) {
      if (!link_to_seams.has(lid)) link_to_seams.set(lid, []);
      link_to_seams.get(lid)!.push(s.id);
    }
    for (const s of seams) {
      const others: string[] = [];
      for (const lid of s.link_ids) for (const sid2 of link_to_seams.get(lid)!)
        if (sid2 !== s.id && !others.includes(sid2)) others.push(sid2);
      s.shares_with = others;
    }

    const role_pills = _CLUSTER_ROLES
      .filter((role) => members.some((h) => h.role === role))
      .map((role) => ({ role, count: members.filter((h) => h.role === role).length }));
    clusters.push({
      id: gid, intent, seams, n_seams: seams.length, role_pills, count: members.length,
      warnings: _aggregate_warnings(cluster_kinds),
    });
  }
  return [clusters, diffs];
}

export async function context_maps(hunks: Hunk[], repo?: string, blast_radius = false):
    Promise<[Map<string, number>, Map<string, string[]>, Map<string, any[]>, Map<string, any>, Map<string, any[]>]> {
  const conf = new Map<string, number>();
  for (const h of hunks) conf.set(h.id, Math.round(h.role_confidence * 100) / 100);
  const ext_all = external_coupling(hunks);
  const refs_all = external_refs(hunks);
  const relevant = new Set<string>();
  for (const h of hunks) if ((h.role === "link" || h.role === "environment") && !h.wires.length && (ext_all.get(h.id) ?? []).length) relevant.add(h.id);
  const ext = new Map<string, string[]>();
  const refs = new Map<string, any[]>();
  for (const hid of relevant) { ext.set(hid, ext_all.get(hid)!); refs.set(hid, refs_all.get(hid) ?? []); }
  const rewire = new Map<string, any>();
  for (const [hid, r] of rewire_pairs(hunks)) if (r.removed.length && r.added.length) rewire.set(hid, r);
  const cons = new Map<string, any[]>();
  if (blast_radius && repo) for (const [hid, cs] of await consumers_for(hunks, repo)) cons.set(hid, cs);
  return [conf, ext, refs, rewire, cons];
}

export async function emit_seams_json(hunks: Hunk[], repo?: string, blast_radius = false): Promise<any> {
  const [clusters] = _build_clusters(hunks, repo);
  const [conf, ext, refs, rewire, cons] = await context_maps(hunks, repo, blast_radius);
  const sugg = new Map<string, string[]>();
  for (const h of hunks) if (h.suggested_wires?.length) sugg.set(h.id, [...h.suggested_wires]);

  const mkHunkOut = (b: Block): any => {
    const d: any = {
      id: b.hid, file: b.file, start: b.start, end: b.end, role: b.role,
      confidence: conf.get(b.hid) ?? 1.0, external: ext.get(b.hid) ?? [],
      externalRefs: refs.get(b.hid) ?? [], rewire: rewire.get(b.hid) ?? null,
    };
    if (cons.size) d.consumers = cons.get(b.hid) ?? [];
    if (sugg.has(b.hid)) d.suggestedWires = sugg.get(b.hid);
    return d;
  };

  const out_clusters: any[] = [];
  clusters.forEach((cl, ci) => {
    const sub = subgroup_seams(cl.seams);
    const entry: any = {
      id: cl.id, intent: cl.intent, colorIndex: ci,
      seams: cl.seams.map((s) => ({
        id: s.id, label: s.label || s.id, linkOnly: !!s.verification.link_only,
        uncertain: !!s.uncertain, warnings: s.verification.warnings.map((w: any) => w.kind),
        hunks: s.blocks.map(mkHunkOut),
      })),
    };
    if (sub) entry.subgroups = sub;
    out_clusters.push(entry);
  });

  const plain = (h: Hunk): any => {
    const [start, end] = _hunk_line_span(h);
    const d: any = {
      id: h.id, file: h.file_path, start, end, role: h.role,
      confidence: Math.round(h.role_confidence * 100) / 100,
      external: ext.get(h.id) ?? [], externalRefs: refs.get(h.id) ?? [], rewire: rewire.get(h.id) ?? null,
    };
    if (cons.size) d.consumers = cons.get(h.id) ?? [];
    return d;
  };

  return {
    clusters: out_clusters,
    tests: hunks.filter((h) => h.role === "test").map(plain),
    noise: hunks.filter((h) => h.role === "noise").map(plain),
  };
}
