// LLM-CONTEXT projection — a token-economical serialization of an emitted codebase seam model, for a
// DOWNSTREAM agent to consume (not a human to read). It is a pure PROJECTION of the same `seams.json`
// (no engine logic, no LLM) — the multi-client contract: one canonical model, many thin clients.
//
// It differs from the human renderings on exactly three principled axes (see docs/INTENT_CULMINATION…):
//   1. NO lossy collapsing — every off-path seam is listed (the "+N more dimmed" roll-up hides recall an
//      LLM could use); 2. CONFIDENCE not a boolean ★ — the climax is a ranked `culminationRanked` list, so
//      a consumer can hedge (the single-pick is fragile on backend flows); 3. token economy — paths +
//      roles + tables + blindspot candidates, never hunk bodies or render chrome.

type Hunk = { file?: string; role?: string };
type Seam = { id: string; label: string; tier?: string; selected?: boolean; suggested?: boolean;
  primary?: { file: string; line: number; symbol: string }; hunks?: Hunk[];
  culmination?: number; writes?: string[]; dir?: string };
type Ranked = { id: string; label: string; score: number; tier?: string; writes?: string[]; dir?: string | null };

const rolesOf = (s: Seam): string => {
  const r = [...new Set((s.hunks ?? []).map((h) => h.role).filter(Boolean))];
  return r.length ? r.join(",") : "—";
};
const filesOf = (s: Seam): string[] => [...new Set((s.hunks ?? []).map((h) => h.file).filter(Boolean) as string[])];
const where = (s: Seam): string => s.primary ? `${s.primary.symbol} (${s.primary.file}:${s.primary.line})` : (filesOf(s)[0] ?? "—");
const facts = (s: Seam): string => {
  const bits: string[] = [];
  if (s.writes && s.writes.length) bits.push(`writes ${s.writes.join(", ")}`);
  if (s.dir) bits.push(s.dir === "backward" ? "downstream" : "upstream entry");
  return bits.length ? `  {${bits.join("; ")}}` : "";
};

export function renderLlmContext(model: any): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  const byId = new Map(seams.map((s) => [s.id, s]));
  const spineIds: string[] = cl.spine ?? [];
  const anchorSym = cl.intent ?? model.anchor ?? "?";
  const out: string[] = [];

  const head = [`anchor: ${anchorSym}`, `resolution: ${model.resolutionQuality ?? "?"}`];
  if (model.shape) head.push(`shape: ${model.shape}`);
  if (model.lead) head.push(`lead: ${model.lead}`);
  head.push(`complete: ${model.complete ? "yes" : "no"}`, `seams: ${seams.length}`);
  out.push(`# Intent footprint`, head.join(" | "), "");

  // SPINE — the main path, in trace order (anchor → … → outcome). The one section a consumer reads first.
  const spine = spineIds.map((id) => byId.get(id)).filter(Boolean) as Seam[];
  if (spine.length) {
    out.push("## Spine (main path, read in order)");
    spine.forEach((s, i) => out.push(`${i + 1}. ${s.label} — ${where(s)}  [roles: ${rolesOf(s)}]${facts(s)}`));
    out.push("");
  }

  // CULMINATION — ranked with confidence, NOT a single boolean. The selected pick is flagged but the
  // runners-up are kept so a consumer can see how close (and how trustworthy) the climax is.
  const ranked: Ranked[] = (cl.culminationRanked ?? []).filter((r: Ranked) => r.score > 0);
  if (ranked.length) {
    out.push("## Culmination (ranked — where the flow's outcome is produced)");
    ranked.slice(0, 5).forEach((r) => {
      const f: string[] = [];
      if (r.writes && r.writes.length) f.push(`writes ${r.writes.join(", ")}`);
      if (r.dir) f.push(r.dir === "backward" ? "downstream" : "upstream entry");
      const sel = r.id === model.selectedSeam ? "  ← selected" : "";
      out.push(`- ${r.label} (score ${r.score.toFixed(2)})${f.length ? " — " + f.join(", ") : ""}${sel}`);
    });
    out.push("");
  } else if (model.selectedSeam) {
    const s = byId.get(model.selectedSeam);
    if (s) out.push("## Culmination", `- ${s.label} — ${where(s)} (topology fallback: far end of the spine)`, "");
  }

  const list = (title: string, items: Seam[]) => {
    if (!items.length) return;
    out.push(`## ${title}`);
    for (const s of items) out.push(`- ${s.label} — ${where(s)}  [roles: ${rolesOf(s)}]${facts(s)}`);
    out.push("");
  };
  const spineSet = new Set(spineIds);
  list("Supporting", seams.filter((s) => s.tier === "supporting"));
  // OFF-path: every one, never collapsed (the deliberate difference from the human view).
  list("Off-path (full — not collapsed)", seams.filter((s) => s.tier === "off"));
  // Spine seams not already shown in the ordered list (defensive — usually none).
  list("Other spine seams", seams.filter((s) => s.tier === "spine" && !spineSet.has(s.id)));

  // BLINDSPOTS — the recall→verify baton: where the static trace stopped, with SUGGESTED candidates to chase.
  const bs: any[] = model.blindspots ?? [];
  if (bs.length) {
    out.push("## Blindspots (unverified edges — verify before trusting)");
    for (const b of bs) {
      const cands = [...new Set((b.candidates ?? []).map((c: any) => c.symbol).filter(Boolean))].slice(0, 6);
      out.push(`- ${b.node}: ${b.mechanism} — ${b.evidence}${cands.length ? `; candidates: ${cands.join(", ")} (SUGGESTED)` : ""}`);
    }
    out.push("");
  }

  out.push("## How to use",
    "Read the Spine top-to-bottom for the mechanism. Treat the Culmination ranking as confidence, not",
    "fact — verify the top pick (the single climax is unreliable on backend cron/queue flows). Off-path",
    "seams are related but a different concern. Blindspot candidates are unproven leads to chase.");
  return out.join("\n");
}
