// REGION render — the dimmed-in-place view of a flood-fill footprint: the whole region at once, each seam
// dimmed by intent relevance rather than reduced to a thin path. A pure projection of the emitted model —
// no engine logic, no LLM.
import { type Seam, type Ranked, rolesOf, where, facts, lineageOf, memberLines } from "./vocab.js";

export function renderLlmContext(model: any): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  const byId = new Map(seams.map((s) => [s.id, s]));
  const anchorSym = cl.intent ?? model.anchor ?? "?";
  const out: string[] = [];

  const head = [`anchor: ${anchorSym}`, `resolution: ${model.resolutionQuality ?? "?"}`];
  if (model.shape) head.push(`shape: ${model.shape}`);
  if (model.lead) head.push(`lead: ${model.lead}`);
  head.push(`complete: ${model.complete ? "yes" : "no"}`, `seams: ${seams.length}`);
  out.push(`# Intent footprint`, head.join(" | "), "");

  // OFF-INTENT — honest signal that the grown footprint barely matches the intent, with the runner-up anchors
  // to re-run on (their scores tell you if a better anchor exists vs the intent having no home here).
  const im = model.intentMatch;
  if (im?.offIntent) {
    out.push(`## ⚠ Low intent match (top relevance ${im.max} < ${im.floor}) — this anchor's flow may not answer the question`);
    if (im.alternatives?.length) for (const a of im.alternatives.slice(0, 5)) out.push(`  try --symbol ${a.name}  (${a.file}, score ${a.score.toFixed(3)})`);
    out.push("");
  }

  // REGION — the flood-fill's actual shape: the anchor + its reach, by DIRECTION (↓ deps = how it works /
  // ↑ consumers = who uses it / ↕ both) and within each by SHELL (hops from the anchor), DIMMED by intent
  // relevance (the model's tier → ●●● on-intent · ●● related · ● peripheral). This replaces the linear "spine":
  // a flood produces a REGION, not a path, so peripheral seams are dimmed IN PLACE, not exiled to an "off"
  // section, and the whole footprint is visible at once rather than a thin trace. Skeleton (no tiers) → ●● all.
  const reld = (s: Seam) => (model.skeleton ? "●●" : s.tier === "spine" ? "●●●" : s.tier === "off" ? "●" : "●●");
  const relRank = (s: Seam) => (s.tier === "spine" ? 0 : s.tier === "off" ? 2 : 1);
  const shellOf = (s: Seam) => ((s as any).region?.shell ?? -1);
  const dirOf = (s: Seam) => ((s as any).region?.direction ?? "");
  const regionLine = (s: Seam) => { const h = shellOf(s); out.push(`  ${reld(s)} ${h >= 0 ? `[${h}] ` : ""}${s.label} — ${where(s)}  [roles: ${rolesOf(s)}]${facts(s)}${lineageOf(s)}`); for (const ml of memberLines(s)) out.push(ml); };
  const bucket = (title: string, members: Seam[]) => {
    if (!members.length) return;
    out.push(title);
    members.sort((a, b) => (shellOf(a) - shellOf(b)) || (relRank(a) - relRank(b))).forEach(regionLine);
  };
  out.push(`## Region (the anchor's flood-fill — [N]=hops out, ●●● on-intent · ●● related · ● peripheral)`);
  const anchorSeams = seams.filter((s) => shellOf(s) === 0);
  for (const s of anchorSeams) { out.push("the anchor:"); regionLine(s); }
  bucket("↓ deps (how it works), nearest first:", seams.filter((s) => shellOf(s) !== 0 && dirOf(s) === "down"));
  bucket("↑ consumers (who uses it), nearest first:", seams.filter((s) => shellOf(s) !== 0 && dirOf(s) === "up"));
  bucket("↕ both directions:", seams.filter((s) => shellOf(s) !== 0 && dirOf(s) === "both"));
  bucket("· (direction not set):", seams.filter((s) => shellOf(s) !== 0 && !["up", "down", "both"].includes(dirOf(s))));
  out.push("");

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
    if (s) out.push("## Culmination", `- ${s.label} — ${where(s)} (topology fallback: deepest on-intent seam)`, "");
  }

  // (Supporting / Off-path / skeleton sections are gone — the Region above shows EVERY seam, dimmed by
  // relevance in place, so nothing is exiled to a separate "off" list or hidden behind a spine.)

  // BLINDSPOTS — the recall→verify baton: where the static trace stopped, with SUGGESTED candidates to chase.
  const bs: any[] = model.blindspots ?? [];
  if (bs.length) {
    out.push("## Blindspots (unverified edges — verify before trusting)");
    // A blindspot WITH candidates is an actionable lead (keep one line per node — the candidates differ).
    // A candidate-LESS blindspot (e.g. `external-libraries`) is ambient — the same mechanism on a dozen
    // nodes is noise, not a dozen leads, so collapse it to one summary line per mechanism.
    // EXCEPTION: a CROSS-STACK data-flow boundary (a shared key whose other side isn't in this footprint —
    // the backend↔frontend case) is neither: the best next move is a SECOND Seam anchored on the other
    // side, NOT a manual grep. Render those with that directive (the evidence already names the key).
    const CROSS = new Set(["llm-proposed-key", "shared-key-fanout"]);
    const ambient = new Map<string, string[]>();
    for (const b of bs) {
      if (CROSS.has(b.mechanism)) {
        out.push(`- ${b.node}: ${b.mechanism} — ${b.evidence}`);
        out.push("    ↪ Unfollowed data-flow boundary. To cross it, run Seam again from the OTHER side —"
          + " intent_footprint / grow_intent with the key above as the intent (or the consumer file as the"
          + " anchor) — and compose the two footprints. Don't fall back to a manual grep sweep.");
        continue;
      }
      // ambient = NO candidate edges to chase (e.g. external-libraries) → collapse; a blindspot WITH
      // candidate edges is an actionable per-node lead even if their symbol names didn't survive emit
      // (the evidence still names the unresolved target, e.g. "OwnerRepository has 2 implementations").
      if (!(b.candidates ?? []).length) { (ambient.get(b.mechanism) ?? ambient.set(b.mechanism, []).get(b.mechanism)!).push(b.node); continue; }
      const cands = [...new Set((b.candidates ?? []).map((c: any) => c.file ? `${c.file}#${c.symbol}` : c.symbol).filter(Boolean))].slice(0, 6);
      out.push(`- ${b.node}: ${b.mechanism} — ${b.evidence}${cands.length ? `; candidates: ${cands.join(", ")} (SUGGESTED)` : ""}`);
    }
    for (const [mech, nodes] of ambient)
      out.push(`- ${mech} — ${nodes.length} node(s)${nodes.length <= 4 ? `: ${nodes.join(", ")}` : ""}`);
    out.push("");
  }

  // LEARNED ADAPTERS (the .seam flywheel): which framework-key adapters this run consulted (replayed
  // offline) + newly learned (LLM once → deterministic forever). Surfaced so they're reviewable/promotable.
  const ad = model.adapters as { used?: { name: string; scope: string }[]; learned?: string[] } | undefined;
  if (ad && ((ad.used?.length ?? 0) || (ad.learned?.length ?? 0))) {
    out.push("## Learned adapters (.seam — framework-key coupling)");
    if (ad.learned?.length) out.push(`NEW this run (LLM-deduced, persisted to .seam/): ${ad.learned.join(", ")}`);
    if (ad.used?.length) out.push(`replayed offline: ${ad.used.map((a) => `${a.name} [${a.scope}]`).join(", ")}`);
    out.push("Review/promote with `seam-adapters list | promote <name>` (repo .seam → shared store).", "");
  }
  out.push("## How to use");
  if (model.skeleton)
    // SKELETON: no LLM tiers/labels were assigned (this output is for an LLM, which tiers/labels better
    // itself than a pre-pass would). So describe the skeleton, not the absent Culmination/Off-path sections.
    out.push(
      "The Region is the anchor's reach: ↓ deps = how it works, ↑ consumers = who uses it, [N] = hops out.",
      "No tiers were assigned (this is for an LLM — judge relevance yourself); labels are structural (symbol",
      "names), so read the code to confirm intent. Blindspot candidates are unproven leads to chase.",
      "Seam footprints COMPOSE: when one ends at a cross-stack blindspot you care about (a data-flow",
      "boundary to a frontend/other service), run a SECOND Seam anchored on the other side and stitch the",
      "two together — that's faster and more complete than a manual grep sweep.");
  else
    out.push(
      "The Region is the anchor's flood-fill: ↓ deps (how it works) / ↑ consumers (who uses it), [N] = hops",
      "from the anchor, and each seam is dimmed by intent relevance (●●● on-intent → ● peripheral) IN PLACE —",
      "the whole footprint at once, no thin path. Treat the Culmination ranking as confidence, not fact —",
      "verify the top pick (the single climax is unreliable on backend cron/queue flows). Blindspot candidates",
      "are unproven leads to chase. Seam footprints COMPOSE: when one ends at a cross-stack blindspot you care",
      "about (a data-flow boundary to a frontend/other service), run a SECOND Seam anchored on the other side",
      "and stitch the two together — that's faster and more complete than a manual grep sweep.");
  return out.join("\n");
}
