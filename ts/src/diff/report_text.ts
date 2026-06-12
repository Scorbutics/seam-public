// Port of src/diff/report_text.py — text renderers: `llm` (markdown) and `ascii` (box-drawing
// tree). Pure formatting over the same assembled model emit_seams_json consumes. Honesty markers
// and codebase-context overlays carried through verbatim.
import type { Hunk } from "./parser.js";
import { _build_clusters, _hunk_line_span, context_maps, type Block, type ClusterDict, type SeamDict } from "./seams.js";
import { subgroup_seams } from "./subgroup.js";

const _ROLE_GLYPH: Record<string, string> = { core: "◆", link: "→", environment: "∙", test: "✓", noise: "·" };
const _ROLE_TAG: Record<string, string> = { core: "core", link: "link", environment: "env ", test: "test", noise: "noise" };

const basename = (p: string) => p.split("/").pop() ?? p;

class Ctx {
  constructor(
    public by_id: Map<string, Hunk>,
    public seam_label: Map<string, string>,
    public ext: Map<string, string[]>,
    public rewire: Map<string, any>,
    public cons: Map<string, any[]>,
  ) {}
}

export async function render(hunks: Hunk[], opts: { style?: string; repo?: string; blast_radius?: boolean } = {}): Promise<string> {
  const style = opts.style ?? "llm";
  const [clusters] = _build_clusters(hunks, opts.repo);
  const [_conf, ext, _refs, rewire, cons] = await context_maps(hunks, opts.repo, opts.blast_radius ?? false);
  const by_id = new Map(hunks.map((h) => [h.id, h]));
  const seam_label = new Map<string, string>();
  for (const cl of clusters) for (const s of cl.seams) seam_label.set(s.id, s.label || s.id);
  const ctx = new Ctx(by_id, seam_label, ext, rewire, cons);
  return (style === "ascii" ? _render_ascii : _render_llm)(hunks, clusters, ctx);
}

const ROLE_ORDER = ["core", "link", "environment", "test", "noise"] as const;

function _counts(hunks: Hunk[], clusters: ClusterDict[]): string {
  const roles = new Map<string, number>();
  for (const h of hunks) roles.set(h.role!, (roles.get(h.role!) ?? 0) + 1);
  const n_seams = clusters.reduce((a, c) => a + c.n_seams, 0);
  const parts = ROLE_ORDER.filter((r) => roles.get(r)).map((r) => `${_ROLE_TAG[r].trim()} ${roles.get(r)}`).join("  ");
  return `${hunks.length} hunks → ${clusters.length} clusters · ${n_seams} seams · ${roles.get("core") ?? 0} cores  (roles: ${parts})`;
}

function _seam_flags(s: SeamDict): string[] {
  const flags: string[] = [];
  if (s.tested) flags.push("tested");
  else if (s.untested) flags.push("⚠ untested");
  if (s.uncertain) flags.push(`~ uncertain ${Math.round((s.confidence ?? 1) * 100)}%`);
  const v = s.verification ?? {};
  if (v.link_only) flags.push("link-only");
  for (const w of v.warnings ?? []) flags.push(`⚠ ${w.kind}`);
  if (s.shares_with?.length) flags.push("↔ " + s.shares_with.join(","));
  return flags;
}

function _consumer_note(consList: any[]): string {
  const n = consList.length;
  const res = consList.filter((c) => c.status === "resolved").length;
  const sug = n - res;
  const split = res ? ` (${res} resolved${sug ? `, ${sug} suggested` : ""})` : " (suggested)";
  const names: string[] = [];
  for (const c of consList) { const b = basename(c.file); if (!names.includes(b)) names.push(b); if (names.length >= 3) break; }
  const more = n > names.length ? " …" : "";
  return `⇲ ${n} consumer${n !== 1 ? "s" : ""} outside diff${split}: ` + names.join(", ") + more;
}

function _note(h: Hunk, ctx: Ctx, currentSeam: string | null = null): string {
  const parts: string[] = [];
  if (h.role === "core" && h.seam_label) parts.push(`defines ${h.seam_label}`);
  const wires = (h.wires ?? []).filter((w) => w !== currentSeam);
  if (wires.length) {
    const sugg = new Set(h.suggested_wires ?? []);
    const labels = wires.map((w) => (sugg.has(w) ? "~" + (ctx.seam_label.get(w) ?? w) : (ctx.seam_label.get(w) ?? w)));
    parts.push("wires: " + labels.slice(0, 4).join(", ") + (labels.length > 4 ? " …" : ""));
  } else if (h.role !== "core" && h.rationale) {
    parts.push(h.rationale.includes("—") ? h.rationale.split("—").slice(1).join("—").trim() : h.rationale);
  }
  const rw = ctx.rewire.get(h.id);
  if (rw && rw.removed?.length && rw.added?.length) parts.push("↻ " + rw.removed.join("/") + " → " + rw.added.join("/"));
  if ((ctx.ext.get(h.id) ?? []).length) parts.push("→ " + ctx.ext.get(h.id)!.slice(0, 2).join(", "));
  if ((ctx.cons.get(h.id) ?? []).length) parts.push(_consumer_note(ctx.cons.get(h.id)!));
  return parts.join("  ·  ");
}

function _loc(h: Hunk, useBasename: boolean): string {
  const f = useBasename ? basename(h.file_path) : h.file_path;
  const [start] = _hunk_line_span(h);
  return start ? `${f}:${start}` : f;
}

// --- block helpers ---
const _block_hunk = (b: Block, ctx: Ctx): Hunk => ctx.by_id.get(b.hid)!;
function _loc_block(b: Block, useBasename: boolean): string {
  const f = useBasename ? basename(b.file) : b.file;
  return b.start ? `${f}:${b.start}` : f;
}
function _note_for_block(b: Block, h: Hunk, ctx: Ctx, seamId: string): string {
  let note = _note(h, ctx, seamId);
  if (b.role !== h.role) note = (`(here: ${b.role}) ` + note).trim();
  return note;
}

const plural = (n: number) => (n !== 1 ? "s" : "");

// --- llm (markdown) ---
const _LEGEND_LLM =
  "Legend: a SEAM = one technical intent (≥1 core + the hunks that wire it). " +
  "core = new logic/decisions · link = wiring · env = ambient support · test = verification. " +
  '"wires: …" connects seams · ⚠ = verify · ~ = uncertain role · ⇲ = consumers outside the diff.';

function _seam_md(s: SeamDict, ctx: Ctx, prefix: string): string[] {
  const flags = _seam_flags(s);
  let head = `${prefix} ${s.id} · ${s.label || s.id}`;
  if (flags.length) head += " — " + flags.join(" · ");
  const lines = [head];
  for (const b of s.blocks) {
    const h = _block_hunk(b, ctx);
    const note = _note_for_block(b, h, ctx, s.id);
    const tag = (_ROLE_TAG[b.role] ?? b.role).padEnd(4);
    const line = `- ${tag}  ${_loc_block(b, false)}`;
    lines.push(line + (note ? `   ${note}` : ""));
  }
  lines.push("");
  return lines;
}

function _render_llm(hunks: Hunk[], clusters: ClusterDict[], ctx: Ctx): string {
  const out: string[] = ["# Seam — diff decomposition", _counts(hunks, clusters), "", _LEGEND_LLM, ""];
  for (const cl of clusters) {
    out.push(`## ${cl.id} · ${cl.intent}`);
    const sub = subgroup_seams(cl.seams);
    if (sub) {
      const byId = new Map(cl.seams.map((s) => [s.id, s]));
      for (const grp of sub) {
        out.push(`### ▸ ${grp.label}  (${grp.seamIds.length} seam${plural(grp.seamIds.length)})`);
        for (const sid of grp.seamIds) out.push(..._seam_md(byId.get(sid)!, ctx, "####"));
      }
    } else for (const s of cl.seams) out.push(..._seam_md(s, ctx, "###"));
  }
  _append_tests_noise(out, hunks, ctx, true);
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

// --- ascii (tree) ---
const _LEGEND_ASCII = "◆ core   → link   ∙ env   ✓ test      ⚠ verify   ~ uncertain   ⇲ outside-diff";

function _seam_ascii(s: SeamDict, ctx: Ctx, prefix: string, isLast: boolean): string[] {
  const [branch, cont] = isLast ? ["└─", "  "] : ["├─", "│ "];
  const flags = _seam_flags(s);
  let head = `${prefix}${branch} ▣ ${s.id}  ${s.label || s.id}`;
  if (flags.length) head += "    " + flags.join(" · ");
  const lines = [head];
  const blocks = s.blocks;
  blocks.forEach((b, bi) => {
    const bBranch = bi === blocks.length - 1 ? "└─" : "├─";
    const h = _block_hunk(b, ctx);
    const glyph = _ROLE_GLYPH[b.role] ?? "·";
    const note = _note_for_block(b, h, ctx, s.id);
    lines.push(`${prefix}${cont} ${bBranch} ${glyph} ${_ROLE_TAG[b.role] ?? b.role} ${_loc_block(b, true)}` + (note ? `   ${note}` : ""));
  });
  return lines;
}

function _render_ascii(hunks: Hunk[], clusters: ClusterDict[], ctx: Ctx): string {
  const out: string[] = [`Seam · ${_counts(hunks, clusters)}`, _LEGEND_ASCII, ""];
  for (const cl of clusters) {
    out.push(`◆ ${cl.id}  ${cl.intent}`);
    const sub = subgroup_seams(cl.seams);
    if (sub) {
      const byId = new Map(cl.seams.map((s) => [s.id, s]));
      sub.forEach((grp, gi) => {
        const [gBranch, gCont] = gi === sub.length - 1 ? ["└─", "   "] : ["├─", "│  "];
        out.push(`${gBranch} ▸ ${grp.label}  (${grp.seamIds.length} seam${plural(grp.seamIds.length)})`);
        const sids = grp.seamIds;
        sids.forEach((sid, si) => out.push(..._seam_ascii(byId.get(sid)!, ctx, gCont, si === sids.length - 1)));
      });
    } else {
      const seamsList = cl.seams;
      seamsList.forEach((s, si) => out.push(..._seam_ascii(s, ctx, "", si === seamsList.length - 1)));
    }
    out.push("");
  }
  _append_tests_noise(out, hunks, ctx, false);
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

function _append_tests_noise(out: string[], hunks: Hunk[], ctx: Ctx, markdown: boolean): void {
  const tests = hunks.filter((h) => h.role === "test");
  const noise = hunks.filter((h) => h.role === "noise");
  if (tests.length) {
    out.push(markdown ? `## Tests (${tests.length}) — skim` : `✓ Tests (${tests.length}) — skim`);
    for (const h of tests) {
      const covers = h.wires.length ? "covers " + h.wires.map((w) => ctx.seam_label.get(w) ?? w).join(", ") : "";
      out.push(`- ${_loc(h, !markdown)}` + (covers ? `   ${covers}` : ""));
    }
    out.push("");
  }
  if (noise.length) {
    out.push(markdown ? `## Noise (${noise.length}) — skip` : `· Noise (${noise.length}) — skip`);
    for (const h of noise) out.push(`- ${_loc(h, !markdown)}`);
    out.push("");
  }
}
