// REGION/WAVE/SCENARIO render family — three views of the SAME flood-fill footprint, differing only in how
// they order and link the seams (dimmed-in-place region, flood-order waves, per-scenario Mermaid sequences).
// Pure projections of the emitted model — no engine logic, no LLM.
import { MEDIA as _MEDIA, WAVE_VERB as _WAVE_VERB, CROSS_SOURCE as _CROSS_SOURCE, CROSS_KINDS as _CROSS_KINDS, WAVE_RANK as _WAVE_RANK } from "./medium_registry.js";
import { type Seam, type Ranked, rolesOf, where, facts, lineageOf, memberLines, _container, _shellOf } from "./vocab.js";

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

// WAVE VIEW — the same region, read as the FLOOD ORDER it grew in: seams grouped by SHELL (the wave/hop the
// flood reached them on), and each new node LINKED BACK to the previous-wave node that reached it, with the
// resolved relation (called by / used by / via route from …). Pure projection of the emitted model — `region.
// shell` gives the wave, `edges` (node-level) give the parent — no engine logic. Answers "how did the flood get
// here?" node-by-node, the stepping stone to a per-scenario sequence view.

// FLOOD TREE — for each seam, the connected seam CLOSER to the anchor (strictly lower shell) that reached it;
// prefer the NEAREST parent (highest shell below it), then the most concrete relation (call > route > import >
// containment). A node-level `edges` link resolves to a seam-to-seam wave link. Shared by the wave view and the
// per-scenario sequence view (the parent links ARE the sequence edges).
function _floodParents(model: any, seams: Seam[]): Map<string, { seam: Seam; kind: string; via: string }> {
  const seamOfNode = new Map<string, Seam>();
  const nodeLabel = new Map<string, string>();
  for (const s of seams) for (const h of (s.hunks ?? [])) { const id = (h as any).id; if (id != null) { seamOfNode.set(String(id), s); nodeLabel.set(String(id), h.label ?? s.label); } }
  const parentOf = new Map<string, { seam: Seam; kind: string; via: string }>();
  for (const e of (model.edges ?? []) as any[]) {
    const a = seamOfNode.get(String(e.from)), b = seamOfNode.get(String(e.to));
    if (!a || !b || a.id === b.id) continue;
    // `via` = the SPECIFIC child-side node the edge reached (the method/route invoked), not the seam's class rep —
    // so a sequence message reads `getExistingBookings`, not `BookingsBean`.
    for (const [child, par, childNode] of [[a, b, e.from], [b, a, e.to]] as [Seam, Seam, string][]) {
      const cs = _shellOf(child), ps = _shellOf(par);
      if (ps < 0 || cs < 0 || ps >= cs) continue;                       // parent must sit closer to the anchor
      const cur = parentOf.get(child.id);
      if (!cur || ps > _shellOf(cur.seam) || (ps === _shellOf(cur.seam) && _WAVE_RANK(e.kind) < _WAVE_RANK(cur.kind)))
        parentOf.set(child.id, { seam: par, kind: e.kind, via: nodeLabel.get(String(childNode)) ?? child.label });
    }
  }
  return parentOf;
}

export function renderWaves(model: any): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  const shellOf = _shellOf;

  const out: string[] = [];
  const head = [`anchor: ${cl.intent ?? model.anchor ?? "?"}`, `resolution: ${model.resolutionQuality ?? "?"}`];
  if (model.shape) head.push(`shape: ${model.shape}`);
  head.push(`complete: ${model.complete ? "yes" : "no"}`, `seams: ${seams.length}`);
  out.push(`# Intent footprint — wave view (flood order)`, head.join(" | "), "");

  const parentOf = _floodParents(model, seams);
  const reld = (s: Seam): string => (model.skeleton ? "" : s.tier === "spine" ? "●●● " : s.tier === "off" ? "● " : "●● ");
  const byShell = new Map<number, Seam[]>();
  for (const s of seams) { const sh = shellOf(s); (byShell.get(sh) ?? byShell.set(sh, []).get(sh)!).push(s); }
  for (const sh of [...byShell.keys()].filter((n) => n >= 0).sort((a, b) => a - b)) {
    out.push(sh === 0 ? "Wave 0 — the anchor:" : `Wave ${sh}:`);
    for (const s of byShell.get(sh)!) {
      const p = parentOf.get(s.id);
      const link = p ? `   ← ${_WAVE_VERB[p.kind] ?? p.kind} ${p.seam.label}` : (sh > 0 ? "   ← (root / cross-stack seed)" : "");
      out.push(`  ${reld(s)}${s.label} — ${where(s)}  [${rolesOf(s)}]${facts(s)}${link}`);
    }
  }
  out.push("", "Each seam is listed at the WAVE the flood reached it (its hop from the anchor); ← names the",
    "previous-wave seam that reached it, and how. Read top-down to replay the flood's growth.");
  return out.join("\n");
}

// SCENARIO SEQUENCE VIEW — the region's distinct USER flows as Mermaid sequence diagrams. A scenario departs from
// its OWN ENTRY POINT (a node nothing in-region calls — the UI action / top of a flow), NOT the anchor: a region
// grown from `loadBookings` also holds `updateBooking`, `cancelBooking`, `getAvailableTimes` as sibling entries
// (reached via a shared route), each its own scenario. We follow the FORWARD CALL GRAPH (call / route / impl —
// the flow direction) from each entry to its deepest terminal, so a scenario is a real invocation chain (UI ->
// route -> handler -> bean -> repo), not a flood-tree link that would false-wire the anchor to a sibling op.
// Same-container nodes share a lifeline; a container change is an arrow labelled by the callee (or the seam label
// when the edge only reached the class) + [HTTP] on a route hop.
const _SCENARIO_CAP = 12, _SEQ_DEPTH_CAP = 24;
const _MERMAID_ID = (s: string): string => (s.replace(/[^A-Za-z0-9]/g, "_").replace(/^(\d)/, "_$1") || "p");
const _seqArrow: Record<string, string> = { "route-serve": "HTTP", "route-fetch": "HTTP", "interface-impl": "impl", "data-coupling": "data" };
// FORWARD (flow-direction) edge kinds: an invocation/dependency the flow follows OUTWARD. `contains` IS included
// (class -> its method) so a flow reached at a CLASS via `route-serve` continues INTO the method that does the
// work — same container, so it folds onto one lifeline, never a spurious message. `data-coupling` (an undirected
// shared-key link) is excluded (not a directed flow step).
const _FWD_KINDS = new Set(["call", "route-fetch", "route-serve", "interface-impl", "reference", "import", "contains"]);

export function renderScenarios(model: any): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  const tierRank = (s?: Seam) => (s?.tier === "spine" ? 0 : s?.tier === "off" ? 2 : 1);

  // NODE INDEX. Each hunk is a node; the model's `edges` are node-level.
  type Info = { seam: Seam; label: string; file?: string };
  const node = new Map<string, Info>();
  for (const s of seams) for (const h of (s.hunks ?? [])) { const id = (h as any).id; if (id != null) node.set(String(id), { seam: s, label: h.label ?? s.label, file: h.file }); }

  // CROSSING BOUNDARY = the synthetic KEY node standing BETWEEN two layers — incident to BOTH a PRODUCE and a
  // CONSUME edge of the SAME medium (a route reached + served, a table written + read, a topic published +
  // subscribed). `crossOf` returns its medium + KEY (the node's own label: the route path / table name) so a link
  // reads `getExistingBookings [HTTP route: /…]` / `[table: bookings]`. A pure producer/consumer CODE node is
  // incident to only ONE side, so it's not mistaken for the boundary.
  const inc = new Map<string, Set<string>>();
  for (const e of (model.edges ?? []) as any[]) { for (const x of [e.from, e.to]) (inc.get(String(x)) ?? inc.set(String(x), new Set()).get(String(x))!).add(e.kind); }
  const crossOf = (id: string): { medium: string; key: string } | null => {
    const k = inc.get(id); if (!k) return null;
    for (const m of _MEDIA) if (k.has(m.produce) && k.has(m.consume)) return { medium: m.medium, key: node.get(id)?.label ?? "" };
    return null;
  };

  // FORWARD GRAPH — ORIENTED by MEANING, not flood order: a call/contains/impl/import goes from→to as-is; a
  // SHARED-KEY crossing (route/table/queue/event/cache/file — emitted symmetrically) is oriented INITIATOR →
  // boundary → RECEIVER by which end is the boundary and whether the edge is the source or sink side. So a UI →
  // route → handler flow and a writer → table → reader flow both traverse in the direction the DATA moves,
  // surviving a sibling entry reached AFTER the anchor (whose shell would mis-orient it). `contains` continues a
  // flow from a class into its method without counting as a "call", so a method stays a valid entry.
  const fwd = new Map<string, { to: string; kind: string }[]>();
  const callIn = new Map<string, number>();
  for (const id of node.keys()) callIn.set(id, 0);
  const addFwd = (f: string, t: string, kind: string) => { if (f === t || !node.has(f) || !node.has(t)) return; const a = fwd.get(f) ?? fwd.set(f, []).get(f)!; if (!a.some((o) => o.to === t && o.kind === kind)) a.push({ to: t, kind }); if (kind !== "contains") callIn.set(t, (callIn.get(t) ?? 0) + 1); };
  for (const e of (model.edges ?? []) as any[]) {
    const f = String(e.from), t = String(e.to);
    if (_CROSS_KINDS.has(e.kind)) {
      const bId = crossOf(f) ? f : crossOf(t) ? t : null; if (!bId) continue;   // the boundary is the two-sided end
      const codeId = bId === f ? t : f;
      if (_CROSS_SOURCE.has(e.kind)) addFwd(codeId, bId, e.kind);   // initiator (client fetch / writer / publisher) → boundary
      else addFwd(bId, codeId, e.kind);                            // boundary → receiver (handler / reader / subscriber)
    } else if (_FWD_KINDS.has(e.kind)) addFwd(f, t, e.kind);
  }
  // ENTRY POINTS = each USER ACTION's departure, NOT the anchor: a non-boundary node that INITIATES a crossing (an
  // outgoing source edge — a UI fetch, a writer's db-write, a publisher's queue-publish), OR a forward-root nothing
  // in-region calls (a backend entry). Each becomes its own scenario. On-intent first, deepest reach.
  const hasOut = (id: string) => (fwd.get(id)?.length ?? 0) > 0;
  const initiates = (id: string) => (fwd.get(id) ?? []).some((o) => _CROSS_SOURCE.has(o.kind));
  const entries = [...node.keys()].filter((id) => !crossOf(id) && hasOut(id) && (initiates(id) || (callIn.get(id) ?? 0) === 0));

  // LONGEST forward path from a node — memoised DAG longest-path, cycle-safe (a back-edge counts 0). O(V+E).
  const memo = new Map<string, { next: string | null; kind: string; len: number }>();
  const inProg = new Set<string>();
  const best = (id: string): { next: string | null; kind: string; len: number } => {
    const m = memo.get(id); if (m) return m;
    if (inProg.has(id)) return { next: null, kind: "", len: 0 };
    inProg.add(id);
    let bl = 0, bn: string | null = null, bk = "";
    for (const o of fwd.get(id) ?? []) { const r = best(o.to); if (r.len + 1 > bl) { bl = r.len + 1; bn = o.to; bk = o.kind; } }
    inProg.delete(id);
    const res = { next: bn, kind: bk, len: bl }; memo.set(id, res); return res;
  };
  const pathFrom = (src: string): { id: string; kind: string }[] => {
    const path: { id: string; kind: string }[] = [{ id: src, kind: "" }];
    const seenN = new Set([src]);
    for (let cur = src; path.length < _SEQ_DEPTH_CAP; ) { const r = best(cur); if (!r.next || seenN.has(r.next)) break; path.push({ id: r.next, kind: r.kind }); seenN.add(r.next); cur = r.next; }
    return path;
  };

  const scenarios = entries.map((src) => ({ src, path: pathFrom(src) }))
    .filter((x) => x.path.length >= 2)
    .sort((a, b) => (tierRank(node.get(a.src)?.seam) - tierRank(node.get(b.src)?.seam)) || (b.path.length - a.path.length));

  const out: string[] = [];
  out.push(`# Intent footprint — scenario sequences`, `anchor: ${cl.intent ?? model.anchor ?? "?"} | resolution: ${model.resolutionQuality ?? "?"}`, "");

  const contOf = (id: string): string => { const i = node.get(id)!; return _container(i.file) || _container(i.seam.primary?.file) || i.seam.label; };
  const emitted: string[] = [];   // participant-transition signatures already drawn — drop a flow that's a SUB-path
  const blocks: string[] = [];
  let n = 0;
  for (const { src, path } of scenarios) {
    if (n >= _SCENARIO_CAP) break;
    const parts: string[] = []; const msgs: string[] = []; const hops: string[] = [];
    let prev: string | null = null;
    let cross: { medium: string; key: string } | null = null;   // a boundary crossed since the last participant
    for (const step of path) {
      const x = crossOf(step.id);
      if (x) { cross = x; continue; }   // the KEY (route/table) is a LINK decoration, not a lifeline — carry it forward
      const c = contOf(step.id), id = _MERMAID_ID(c), info = node.get(step.id)!;
      if (!parts.includes(`${id}\t${c}`)) parts.push(`${id}\t${c}`);
      if (prev !== null && prev !== id) {
        const msg = info.label && info.label !== c && !info.label.startsWith("/") ? info.label : info.seam.label;
        // the link between the two layers: the actual coupling key when one was crossed (an http-route / table),
        // else the plain relation marker ([impl]/[data]) — a same-file call is unmarked.
        const link = cross ? ` [${cross.medium}: ${cross.key}]` : (_seqArrow[step.kind] ? ` [${_seqArrow[step.kind]}]` : "");
        msgs.push(`  ${prev}->>${id}: ${msg}${link}`);
        hops.push(`${prev}>${id}`);
        cross = null;
      }
      prev = id;
    }
    if (!msgs.length) continue;                                 // whole flow in one container -> not a sequence
    // SUB-PATH dedup: a flow whose component-transition sequence is contained in an already-drawn (longer) one is
    // just its tail (a backend-only entry under a full UI→DB flow) — skip it. Scenarios are sorted longest-first;
    // the bar delimiters make the containment test hop-exact (no partial-name false match).
    const sig = "|" + hops.join("|") + "|";
    if (emitted.some((e) => e.includes(sig))) continue;
    emitted.push(sig);
    n++;
    const endInfo = node.get(path[path.length - 1].id)!, srcInfo = node.get(src)!;
    const endSym = endInfo.seam.primary?.symbol ?? endInfo.label, srcSym = srcInfo.seam.primary?.symbol ?? srcInfo.label;
    blocks.push(`## Scenario ${n}: ${srcSym} -> ${endSym}`, "```mermaid", "sequenceDiagram",
      ...parts.map((p) => { const [id, disp] = p.split("\t"); return `  participant ${id} as ${disp}`; }), ...msgs, "```", "");
  }
  out[1] = out[1] + ` | scenarios: ${n}`;
  if (!n) { out.push("(no cross-component user flow to draw — the region's entries stay within one component; read the wave view.)"); return out.join("\n"); }
  out.push(...blocks);
  out.push("Each diagram is ONE user flow, departing from its OWN entry point (not the anchor) and following the",
    "forward call + data-coupling graph to its deepest terminal; same-class steps share a lifeline. A bracket on",
    "a link names the shared-key crossing between two layers — [HTTP route: /path], [table: name], [queue: topic].");
  return out.join("\n");
}
