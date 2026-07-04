// LLM-CONTEXT projection — a token-economical serialization of an emitted codebase seam model, for a
// DOWNSTREAM agent to consume (not a human to read). It is a pure PROJECTION of the same `seams.json`
// (no engine logic, no LLM) — the multi-client contract: one canonical model, many thin clients.
//
// It differs from the human renderings on exactly three principled axes (see docs/INTENT_CULMINATION…):
//   1. NO lossy collapsing — every off-path seam is listed (the "+N more dimmed" roll-up hides recall an
//      LLM could use); 2. CONFIDENCE not a boolean ★ — the climax is a ranked `culminationRanked` list, so
//      a consumer can hedge (the single-pick is fragile on backend flows); 3. token economy — paths +
//      roles + tables + blindspot candidates, never hunk bodies or render chrome.

type Hunk = { file?: string; role?: string; label?: string; enclosing?: string; kind?: string; start?: number; relevance?: number; spine?: boolean };
type Seam = { id: string; label: string; tier?: string; selected?: boolean; suggested?: boolean;
  primary?: { file: string; line: number; symbol: string }; hunks?: Hunk[];
  culmination?: number; writes?: string[]; dir?: string;
  lineage?: { sha: string; subject: string; author: string; date: string } };
type Ranked = { id: string; label: string; score: number; tier?: string; writes?: string[]; dir?: string | null };

const rolesOf = (s: Seam): string => {
  const r = [...new Set((s.hunks ?? []).map((h) => h.role).filter(Boolean))];
  return r.length ? r.join(",") : "—";
};
const filesOf = (s: Seam): string[] => [...new Set((s.hunks ?? []).map((h) => h.file).filter(Boolean) as string[])];
// The file's container stem (Java: one public class per file = the class; elsewhere the module/file name). Used
// to QUALIFY a bare method name so two same-named methods in different classes are distinguishable at a glance
// (the acme case: BookingsBean.createBooking vs AcmeCheckBookingsService.createBooking). Only when it
// adds information (≠ the symbol, so a class node `BookingsBean` isn't rendered `BookingsBean.BookingsBean`).
const _container = (f?: string): string => (f ? (f.split("/").pop() ?? f).replace(/\.[^.]+$/, "") : "");
const where = (s: Seam): string => {
  if (!s.primary) return filesOf(s)[0] ?? "—";
  const c = _container(s.primary.file);
  const qualified = c && c !== s.primary.symbol ? `${c}.${s.primary.symbol}` : s.primary.symbol;
  return `${qualified} (${s.primary.file}:${s.primary.line})`;
};
const facts = (s: Seam): string => {
  const bits: string[] = [];
  if (s.writes && s.writes.length) bits.push(`writes ${s.writes.join(", ")}`);
  if (s.dir) bits.push(s.dir === "backward" ? "downstream" : "upstream entry");
  return bits.length ? `  {${bits.join("; ")}}` : "";
};
// git lineage — the deterministic "why" (last-touching commit). Shown inline so an LLM reads provenance
// it can trust alongside the code location.
const lineageOf = (s: any): string => s.lineage ? `  ↳ ${s.lineage.sha} "${s.lineage.subject}" (${s.lineage.author}, ${s.lineage.date})` : "";

// The intent-RELEVANT MEMBERS inside a seam — the embedding-ranked spine the floor collapsed into one
// blob. Without these a tangled (god-object / DI) seam renders as one near-empty line; with them the
// reader sees WHICH of the N members answer the intent. Only the `spine`-flagged members (top, above
// the seam's mean), highest relevance first, capped. Empty when embeddings were unavailable.
const _MEMBER_CAP = 8;
const memberLines = (s: Seam): string[] => {
  const sp = (s.hunks ?? []).filter((h) => h.spine && typeof h.relevance === "number")
    .sort((a, b) => (b.relevance! - a.relevance!)).slice(0, _MEMBER_CAP);
  return sp.map((h) => `     ★ ${h.relevance!.toFixed(2)} ${h.label ?? "?"}${h.file ? ` (${h.file}:${h.start ?? 0})` : ""}`);
};

// EDGE-SET projection — the flat, tier-grouped render shared by the consumers (`shape:"set"`, in-edges)
// and dependencies (`shape:"deps"`, out-edges) shapes. NOT numbered spine steps — a set has no order.
// Honest about the floor: resolved members are the verified answer; suggested are leads; the unresolved
// bucket is "grep these"; noStructure routes the asker away entirely. The two public renderers below fix
// the direction-specific wording. See grow/project_set.ts.
interface EdgeSetLabels { title: string; nounPl: string; noneText: string }
function renderEdgeSet(model: any, L: EdgeSetLabels): string {
  const members: any[] = model.members ?? [];
  const unresolved: any[] = model.unresolved ?? [];
  const recalled: any[] = model.recalled ?? [];
  const resolved = members.filter((m) => m.provenance !== "SUGGESTED");
  const suggested = members.filter((m) => m.provenance === "SUGGESTED");
  const out: string[] = [];
  const head = [`anchor: ${model.anchor?.symbol ?? "?"}`, `shape: ${model.shape}`, `resolution: ${model.resolutionQuality ?? "?"}`,
    `resolved: ${resolved.length}`, `suggested: ${suggested.length}`, `unresolved: ${unresolved.length}`,
    ...(recalled.length ? [`recalled: ${recalled.length}`] : [])];
  out.push(`# ${L.title} ${model.anchor?.symbol ?? "?"}`, head.join(" | "), "");

  // noStructure — the honest negative. Say it plainly and route to grep; do NOT pad with a half-answer.
  if (model.noStructure) {
    out.push(model.reason === "opaque"
      ? `## No resolved ${L.nounPl}\n${L.nounPl[0].toUpperCase() + L.nounPl.slice(1)} exist but none resolve structurally`
        + " (opaque imports / dynamic dispatch). This is a grep/LSP question — Seam can't verify the edges here."
      : `## No ${L.nounPl}\n${L.noneText}`);
    out.push("");
  }

  const member = (m: any): string => `- ${m.symbol} (${m.file}:${m.line})  [${m.kind}, ${m.edgeKind}]${m.enclosing ? `  in ${m.enclosing}` : ""}`;
  if (resolved.length) {
    out.push(`## Resolved ${L.nounPl} (verified edges)`);
    for (const m of resolved) out.push(member(m) + `  {${m.provenance}}`);
    out.push("");
  }
  if (suggested.length) {
    out.push(`## Suggested ${L.nounPl} (unverified leads — confirm before trusting)`);
    for (const m of suggested) out.push(member(m));
    out.push("");
  }
  if (unresolved.length) {
    out.push(`## Unresolved ${L.nounPl} (opaque — grep these)`);
    for (const u of unresolved) out.push(`- ${u.mechanism} — ${u.evidence}${u.candidates.length ? `; candidates: ${u.candidates.join(", ")}` : ""}`);
    out.push("");
  }
  if (recalled.length) {
    out.push(`## Recalled ${L.nounPl} (name-grounded — UNVERIFIED, confirm before trusting)`);
    for (const m of recalled) out.push(member(m));
    out.push("");
  }
  out.push("## How to use",
    `Resolved ${L.nounPl} are the verified set (correct where grep yields false positives from`,
    `comments/strings/same-name symbols). Suggested ${L.nounPl} are leads the resolver couldn't ground.`,
    `Unresolved ${L.nounPl} are opaque to static analysis — grep is the right tool for those.`,
    ...(recalled.length ? [`Recalled ${L.nounPl} use the symbol NAME in a code position but aren't import-verified`,
      "(a same-named symbol elsewhere can match) — they recover edges in languages without symbol imports",
      "(Ruby globals, C/C++), but confirm each before trusting."] : []));
  return out.join("\n");
}

// CONSUMERS (`shape:"set"`) — who calls/uses the anchor (in-edges).
export function renderConsumerSet(model: any): string {
  if (!model || model.shape !== "set") return "(not a consumer-set model)";
  return renderEdgeSet(model, { title: "Consumers of", nounPl: "callers",
    noneText: "Nothing in the repo calls this symbol — an entry point, dead code, or dispatched-only." });
}

// DEPENDENCIES (`shape:"deps"`) — what the anchor calls/uses (out-edges).
export function renderDependencySet(model: any): string {
  if (!model || model.shape !== "deps") return "(not a dependency-set model)";
  return renderEdgeSet(model, { title: "Dependencies of", nounPl: "dependencies",
    noneText: "This symbol uses nothing resolvable — a leaf (no outgoing dependencies)." });
}

// REFACTOR-FACTS bundle — "how to refactor X": the FACTS (impact + dependencies + contract) stitched
// together so a planner has the whole structural picture. The PLAN itself is NOT here — it's a judgement
// for the model/human to make over these facts. See grow/refactor_facts.ts.
export function renderRefactorFacts(model: any): string {
  if (!model || model.shape !== "refactor") return "(not a refactor-facts model)";
  const sym = model.anchor?.symbol ?? "?";
  const im = model.impact ?? {}, dep = model.dependencies ?? {}, ct = model.contract ?? {};
  const out: string[] = [];
  out.push(`# Refactor facts for ${sym} (${model.anchor?.file ?? "?"})`,
    [`impact: ${im.total ?? 0} across ${im.fileCount ?? 0} file(s)${im.gaps?.length ? `, ${im.gaps.length} gap(s)` : ""}`,
     `dependencies: ${(dep.members ?? []).length}`,
     `contract: ${(ct.provides ?? []).length} provided, ${(ct.unusedExports ?? []).length} unused`].join(" | "),
    "", "These are the FACTS to plan a change to " + sym + " — the change PLAN over them is yours to make.", "");
  out.push("─".repeat(4) + " IMPACT (what breaks if you change it) " + "─".repeat(4), renderImpact(im), "");
  out.push("─".repeat(4) + " DEPENDENCIES (what it uses) " + "─".repeat(4), renderDependencySet(dep), "");
  out.push("─".repeat(4) + " CONTRACT (its boundary) " + "─".repeat(4), renderContract(ct));
  return out.join("\n");
}

// IMPACT projection — the transitive blast radius: the affected symbols (hop-sorted), a file rollup, the
// SURFACE (outermost callers — where the change ripples to), and the GAPS (opaque callers where the view
// is incomplete). The refactoring safety net. See grow/impact.ts.
export function renderImpact(model: any): string {
  if (!model || model.shape !== "impact") return "(not an impact model)";
  const sym = model.anchor?.symbol ?? "?";
  const out: string[] = [];
  out.push(`# Impact of ${sym} (change blast radius)`,
    [`impacted: ${model.total}`, `files: ${model.fileCount}`, `surface: ${(model.surface ?? []).length}`,
     `gaps: ${(model.gaps ?? []).length}`, ...(model.truncated ? ["truncated: yes (impact ≥ shown)"] : [])].join(" | "), "");
  if (model.noStructure) {
    out.push("## Isolated", model.reason === "opaque"
      ? `${sym} has no RESOLVED consumers, but ${(model.gaps ?? []).length} opaque caller(s) exist — verify those before assuming it's safe to change (see gaps below).`
      : `${sym} has no consumers in the repo — changing it is isolated (an entry point, dead code, or dispatched-only).`);
    if ((model.gaps ?? []).length) { out.push("", "## Gaps (opaque callers — grep these)"); for (const g of model.gaps) out.push(`- ${g.mechanism} — ${g.evidence}`); }
    return out.join("\n");
  }
  // Affected, grouped by file (most-affected first), with hop distance per symbol.
  out.push("## Affected (by file — update these)");
  for (const f of model.files) {
    out.push(`- ${f.file}  (${f.count})`);
    for (const m of (model.impacted ?? []).filter((x: any) => x.file === f.file))
      out.push(`    ${m.symbol} (:${m.line}) [${m.kind}, hop ${m.hop}]`);
  }
  out.push("");
  if ((model.surface ?? []).length) {
    out.push("## Surface (outermost callers — where the change ripples to; re-verify here)");
    for (const m of model.surface) out.push(`- ${m.symbol} (${m.file}:${m.line})`);
    out.push("");
  }
  if ((model.gaps ?? []).length) {
    out.push("## Gaps (opaque callers — the impact set may be INCOMPLETE here; grep these)");
    for (const g of model.gaps) out.push(`- ${g.mechanism} — ${g.evidence}`);
    out.push("");
  }
  out.push("## How to use",
    "Every Affected symbol transitively depends on the anchor — these are the sites a change must account",
    "for (hop = distance from the anchor). Surface = the outermost callers the change reaches (entry points /",
    "tests to re-verify). Gaps are where resolution gave out — the true impact may be larger, so grep those.",
    `${model.truncated ? "Truncated: the closure hit the budget — impact is AT LEAST what's shown. " : ""}This is the`,
    "structural blast radius; the refactoring PLAN over it is a judgement for you/the model to make.");
  return out.join("\n");
}

// COMPARISON projection — diff two symbols' dependency sets: shared / A-only / B-only, with a similarity
// (Jaccard) readout. A-only vs B-only is where the two implementations diverge. See grow/compare.ts.
export function renderComparison(model: any): string {
  if (!model || model.shape !== "comparison") return "(not a comparison model)";
  const aS = model.a?.symbol ?? "A", bS = model.b?.symbol ?? "B";
  const out: string[] = [];
  out.push(`# Comparison: ${aS} vs ${bS} (by dependencies)`,
    [`a: ${aS} (${model.a?.file})`, `b: ${bS} (${model.b?.file})`,
     `shared: ${(model.shared ?? []).length}`, `${aS}-only: ${(model.aOnly ?? []).length}`,
     `${bS}-only: ${(model.bOnly ?? []).length}`, `similarity: ${Math.round((model.similarity ?? 0) * 100)}%`].join(" | "), "");
  if (model.noStructure) {
    out.push("## Nothing to compare", `Neither ${aS} nor ${bS} has resolved dependencies — no structural difference to report.`);
    return out.join("\n");
  }
  const dep = (d: any) => `- ${d.symbol} (${d.file})${d.kind ? `  [${d.kind}]` : ""}`;
  const list = (title: string, items: any[]) => { if (items.length) { out.push(`## ${title}`); for (const d of items) out.push(dep(d)); out.push(""); } };
  list("Shared dependencies (both use)", model.shared ?? []);
  list(`Only ${aS} (its distinct mechanism)`, model.aOnly ?? []);
  list(`Only ${bS} (its distinct mechanism)`, model.bOnly ?? []);
  out.push("## How to use",
    `Shared deps are the common ground. ${aS}-only and ${bS}-only are where the two diverge — the distinct`,
    "parts of each implementation. Similarity is the Jaccard overlap of the dependency sets (100% = identical",
    "dependencies, 0% = disjoint mechanisms).");
  return out.join("\n");
}

// NEIGHBORHOOD projection — the cohesive subsystem around an anchor: the CORE files (weak-community:
// internal edges ≥ external) vs the PERIPHERY, with the boundary cut + a cohesion readout. See
// grow/neighborhood.ts.
export function renderNeighborhood(model: any): string {
  if (!model || model.shape !== "neighborhood") return "(not a neighborhood model)";
  const out: string[] = [];
  out.push(`# Subsystem around ${model.anchor?.symbol ?? "?"}`,
    [`core: ${(model.coreFiles ?? []).length}`, `periphery: ${(model.peripheryFiles ?? []).length}`,
     `cohesion: ${Math.round((model.cohesion ?? 0) * 100)}%`, `boundary cut: ${model.boundaryCut} edge(s)`,
     `depth: ${model.depth}`].join(" | "), "");
  if (model.noStructure) {
    out.push("## No subsystem", `${model.anchor?.symbol ?? "?"} has no cross-file edges — it stands alone, there is no cohesive unit around it.`);
    return out.join("\n");
  }
  const row = (m: any) => `- ${m.file}  (internal ${m.internal}, out ${m.external})${m.symbols.length ? `  {${m.symbols.slice(0, 6).join(", ")}${m.symbols.length > 6 ? ", …" : ""}}` : ""}`;
  const core = (model.members ?? []).filter((m: any) => m.core);
  const peri = (model.members ?? []).filter((m: any) => !m.core);
  if (core.length) { out.push("## Core (the cohesive subsystem — internal ≥ external)"); for (const m of core) out.push(row(m)); out.push(""); }
  if (peri.length) { out.push("## Periphery (loosely attached — more edges leave than stay)"); for (const m of peri) out.push(row(m)); out.push(""); }
  out.push("## How to use",
    "Core files are the cohesive subsystem (weak-community: each keeps at least as many edges inside as it",
    "sheds outside — parameter-free, no threshold). Periphery files touch the subsystem but lean outward.",
    "Boundary cut = edges the core sheds to the rest of the codebase — the subsystem's blast-radius surface.");
  return out.join("\n");
}

// CONTRACT projection — a module's boundary: the INBOUND cut (used exports + who consumes them), dead
// public API (unused exports), and the OUTBOUND cut (resolved external imports), with fan-in/out. See
// grow/contract.ts.
export function renderContract(model: any): string {
  if (!model || model.shape !== "contract") return "(not a contract model)";
  const out: string[] = [];
  out.push(`# Contract: ${model.module}`,
    [`provides: ${(model.provides ?? []).length}`, `unused exports: ${(model.unusedExports ?? []).length}`,
     `depends: ${(model.depends ?? []).length}`, `fan-in: ${model.afferent}`, `fan-out: ${model.efferent}`].join(" | "), "");
  if (model.noStructure) {
    out.push("## No contract", "This file has no exported members — there is no module boundary to describe.");
    return out.join("\n");
  }
  if ((model.provides ?? []).length) {
    out.push("## Provides (inbound — exports consumed elsewhere)");
    for (const p of model.provides) {
      out.push(`- ${p.symbol} [${p.kind}] — ${p.consumerCount} consumer(s)`);
      for (const c of p.consumers) out.push(`    ← ${c.symbol} (${c.file})`);
    }
    out.push("");
  }
  if ((model.unusedExports ?? []).length) {
    out.push("## Unused exports (no external consumer — dead public API)", ...model.unusedExports.map((s: string) => `- ${s}`), "");
  }
  if ((model.depends ?? []).length) {
    out.push("## Depends (outbound — resolved external imports)");
    for (const d of model.depends) out.push(`- ${d.symbol} → ${d.file}${d.source ? `  (from '${d.source}')` : ""}`);
    out.push("");
  }
  out.push("## How to use",
    "Provides is the module's real public surface (declared exports that are ACTUALLY imported), with each",
    "consumer. Unused exports are dead public API — safe-to-narrow candidates. Depends is the outbound cut.",
    "fan-in (afferent) / fan-out (efferent) are the coupling pair: high fan-in = changing this ripples wide.");
  return out.join("\n");
}

// REACHABILITY projection — "can FROM reach TO?" rendered as the verdict + the witness path (resolved
// edges, in order). The three negatives stay distinct: unreachable (a real no), exhausted (inconclusive
// — budget ran out), no-out-edges (FROM unanalyzable). See grow/reach.ts.
export function renderReach(model: any): string {
  if (!model || model.shape !== "reaches") return "(not a reachability model)";
  const out: string[] = [];
  const fromS = model.from?.symbol ?? "?", toS = model.to?.symbol ?? "?";
  out.push(`# Reachability: ${fromS} → ${toS}`,
    [`from: ${fromS} (${model.from?.file ?? "?"})`, `to: ${toS}${model.to?.file ? ` (${model.to.file})` : ""}`,
     `reachable: ${model.reachable ? "yes" : "no"}`, `reason: ${model.reason}`, `explored: ${model.hops} hop(s)`].join(" | "), "");
  if (model.reachable) {
    out.push("## Witness path (resolved edges, in order)");
    (model.path ?? []).forEach((s: any, i: number) => out.push(`${i + 1}. ${s.symbol} (${s.file}:${s.line})${s.edgeKind && s.edgeKind !== "anchor" ? `  [${s.edgeKind}]` : "  [anchor]"}`));
  } else {
    out.push("## No path",
      model.reason === "exhausted"
        ? `No path found within ${model.hops} hops — INCONCLUSIVE. A path may exist beyond the budget; raise --max-hops to be sure.`
        : model.reason === "no-out-edges"
          ? `${fromS} has no resolved dependencies — reachability is undefined (a leaf, or its calls don't resolve statically).`
          : `${fromS} cannot reach ${toS}: the entire resolved dependency closure was searched and ${toS} is not in it.`);
  }
  out.push("", "## How to use",
    "A 'yes' is a PROVEN connection — every step is a resolved edge. 'unreachable' searched the whole",
    "resolved closure (trustworthy). 'exhausted' only means not-within-budget (inconclusive). 'no-out-edges'",
    "means FROM itself couldn't be analyzed — not that TO is unreachable.");
  return out.join("\n");
}

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
      const cands = [...new Set((b.candidates ?? []).map((c: any) => c.symbol).filter(Boolean))].slice(0, 6);
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
// SHARED-KEY MEDIA — each coupling archetype's [medium, PRODUCE edge, CONSUME edge]. A crossing over any of these
// is a link between two layers via a shared KEY (a route path / table / topic), not a direct call. `pull` = the
// CONSUMER initiates the flow (an HTTP client fetch); otherwise the PRODUCER does (a writer / publisher / emitter
// pushing to the boundary). Drives boundary detection, the wave link verb, and the scenario orientation below.
const _MEDIA: { medium: string; produce: string; consume: string; pull?: boolean; wave: string }[] = [
  { medium: "HTTP route", produce: "route-serve", consume: "route-fetch", pull: true, wave: "via HTTP route from" },
  { medium: "table", produce: "db-write", consume: "db-read", wave: "sharing a DB table with" },
  { medium: "queue", produce: "queue-publish", consume: "queue-subscribe", wave: "over a queue with" },
  { medium: "event", produce: "event-emit", consume: "event-on", wave: "via an event with" },
  { medium: "cache", produce: "cache-write", consume: "cache-read", wave: "sharing a cache with" },
  { medium: "file", produce: "file-write", consume: "file-read", wave: "sharing a file with" },
];
// edge-kind → medium; and the SOURCE edges (point code→boundary: the consumer's fetch for a pull medium, the
// producer's write/publish otherwise) vs SINK edges (boundary→code: deliver to the receiver).
const _MEDIUM_OF = new Map<string, { medium: string; wave: string }>();
const _CROSS_SOURCE = new Set<string>(), _CROSS_SINK = new Set<string>(), _CROSS_KINDS = new Set<string>();
for (const m of _MEDIA) {
  _MEDIUM_OF.set(m.produce, m); _MEDIUM_OF.set(m.consume, m);
  const src = m.pull ? m.consume : m.produce, sink = m.pull ? m.produce : m.consume;
  _CROSS_SOURCE.add(src); _CROSS_SINK.add(sink); _CROSS_KINDS.add(m.produce); _CROSS_KINDS.add(m.consume);
}
const _WAVE_VERB: Record<string, string> = {
  call: "called by", import: "used by", reference: "referenced by", "interface-impl": "implemented by",
  contains: "declared in", "type-ref": "typed by", "data-coupling": "sharing a key with",
};
for (const [kind, m] of _MEDIUM_OF) _WAVE_VERB[kind] = m.wave;   // every shared-key crossing names its medium
const _WAVE_RANK = (k: string): number => (k === "call" ? 0 : _CROSS_KINDS.has(k) ? 1 : k === "import" || k === "reference" || k === "interface-impl" ? 2 : k === "contains" ? 4 : 3);
const _shellOf = (s: Seam): number => ((s as any).region?.shell ?? -1);

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

// AGENT RENDER (Phase 3) — the ONE token-budgeted projection a coding agent reads instead of reconstructing a
// flow with a grep loop. Pure (reads only the emitted model, zero LLM, skeleton-compatible). Sections, in order:
// header · spine · region-by-tier · hubs · frontier · blindspots/unresolved. Everything a caller must TRUST —
// the spine, the collapsed hubs, the decision-point frontier, the honest gaps — is EXEMPT from budget cropping;
// only the off-path/supporting region lines (then hub sample-consumer detail) degrade, and WHAT was cropped is
// stated (I3). Reuses the same where/rolesOf/_WAVE_VERB vocabulary as the other views (one render language).
export function renderAgent(model: any, opts: { tokenBudget?: number; intent?: string } = {}): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  const budget = Math.max(300, opts.tokenBudget ?? 4000);
  const tok = (lines: string[]) => Math.ceil(lines.join("\n").length / 4);

  // id → label + the seam each node lives in (for reach phrases that stop at the seam boundary).
  const label = new Map<string, string>();
  const seamOfId = new Map<string, string>();
  for (const s of seams) for (const h of (s.hunks ?? [])) { const id = (h as any).id; if (id != null) { label.set(String(id), h.label ?? s.label); seamOfId.set(String(id), s.id); } }
  const allIds = new Set(label.keys());
  const seamIds = (s: Seam) => new Set((s.hunks ?? []).map((h) => String((h as any).id)).filter((x) => x !== "undefined"));
  // reachedVia for a SEAM: the resolved relation(s) that reached it from a node OUTSIDE the seam (same vocabulary
  // as the frontier's reachedVia — the incoming edge kind → its wave verb). Best 1–2, ranked by relation concreteness.
  const reachSeam = (s: Seam): string => {
    const ids = seamIds(s);
    const cands: { r: number; s: string }[] = [];
    for (const e of (model.edges ?? []) as any[]) {
      const f = String(e.from), t = String(e.to);
      if (ids.has(t) && !ids.has(f) && allIds.has(f)) cands.push({ r: _WAVE_RANK(e.kind), s: `${_WAVE_VERB[e.kind] ?? "reached from"} ${label.get(f)}` });
    }
    cands.sort((a, b) => a.r - b.r);
    const uniq = [...new Set(cands.map((c) => c.s))].slice(0, 2);
    return uniq.length ? uniq.join(", ") : "the anchor / region root";
  };
  const cross = (s: Seam): string => (s.writes && s.writes.length ? `  [crossing: ${s.writes.join(", ")}]` : "");

  const tierOf = (s: Seam) => s.tier ?? "";
  const hasSpine = seams.some((s) => tierOf(s) === "spine");
  const spineSeams = seams.filter((s) => tierOf(s) === "spine");
  const supporting = seams.filter((s) => tierOf(s) !== "spine" && tierOf(s) !== "off");
  const offSeams = seams.filter((s) => tierOf(s) === "off");
  // collapsed hubs — the hub-marked hunks across the region (Phase 1); one line per hub node.
  // DEDUPE: a hub-marked hunk appears in every seam it wires (a hub wires many), so a naive scan lists it once per
  // seam — the same `BookingsBean` line a dozen times. Key by (file, label, reason) → one line per collapsed hub.
  const hubs: { label: string; file?: string; hub: any }[] = [];
  const seenHub = new Set<string>();
  for (const s of seams) for (const h of (s.hunks ?? [])) {
    const hb = (h as any).hub; if (!hb) continue;
    const k = `${h.file ?? ""}|${h.label ?? ""}|${hb.reason ?? ""}`;
    if (seenHub.has(k)) continue; seenHub.add(k);
    hubs.push({ label: h.label ?? "?", file: h.file, hub: hb });
  }
  const frontier: any[] = model.frontier ?? [];

  const q = (x: string) => (opts.intent ? ` --intent "${opts.intent}"` : x);   // the deepen invocation carries the intent to redirect

  // ---- section builders (each returns its lines) ----
  const header = (): string[] => {
    const h = [`anchor: ${cl.intent ?? model.anchor ?? "?"}`];
    if (opts.intent) h.push(`intent: ${opts.intent}`);
    h.push(`resolution: ${model.resolutionQuality ?? "?"}`, `seams: ${seams.length}`,
      `unresolved: ${(model.unresolved ?? []).length}`, `blindspots: ${(model.blindspots ?? []).length}`);
    const out = ["# Agent map — the region to read instead of a grep loop", h.join(" | ")];
    const im = model.intentMatch;
    if (im?.offIntent) out.push(`⚠ low intent match (top ${im.max} < ${im.floor}) — this anchor's flow may not answer the intent`);
    return out;
  };
  const seamLine = (s: Seam, n?: number) => `  ${n != null ? `${n}. ` : ""}${where(s)} — ${rolesOf(s)} — ${reachSeam(s)}${cross(s)}`;
  const spineSection = (): string[] => {
    if (!hasSpine) return [];
    const out = ["", "## Spine (the primary path, anchor → … → outcome)"];
    spineSeams.forEach((s, i) => out.push(seamLine(s, i + 1)));
    return out;
  };
  const regionSection = (dropOff: boolean, dropSupporting: boolean): string[] => {
    const out: string[] = ["", hasSpine ? "## Region (remaining, by relevance)" : "## Region (by shell — nearest the anchor first)"];
    if (!hasSpine) {   // no-intent / skeleton fallback: order every seam by shell (hops from the anchor)
      [...seams].sort((a, b) => (_shellOf(a) - _shellOf(b))).forEach((s) => out.push(seamLine(s)));
      return out;
    }
    if (supporting.length) {
      if (dropSupporting) out.push(`  supporting: ${supporting.length} seam(s) — cropped to fit the ${budget}-token budget (raise --token-budget to see them)`);
      else { out.push("supporting:"); [...supporting].sort((a, b) => _shellOf(a) - _shellOf(b)).forEach((s) => out.push(seamLine(s))); }
    }
    if (offSeams.length) {
      if (dropOff) out.push(`  off-path: ${offSeams.length} seam(s) — cropped to fit the ${budget}-token budget`);
      else { out.push("off-path:"); [...offSeams].sort((a, b) => _shellOf(a) - _shellOf(b)).forEach((s) => out.push(seamLine(s))); }
    }
    return out;
  };
  const hubsSection = (dropSamples: boolean): string[] => {
    if (!hubs.length) return [];
    const out = ["", "## Collapsed hubs (ubiquitous — expand explicitly if needed)"];
    for (const h of hubs) {
      const s = h.hub.sampleConsumers ?? [];
      const sample = (!dropSamples && s.length) ? `, e.g. ${s.slice(0, 3).join(", ")}` : "";
      out.push(`  ${h.label}${h.file ? ` (${h.file})` : ""} — hub: ${h.hub.reason}, fan ${h.hub.fan}${sample}`);
    }
    return out;
  };
  const frontierSection = (): string[] => {
    if (!frontier.length) return [];
    const out = ["", "## Frontier (decision points — deepen the ones that matter)"];
    for (const f of frontier) out.push(`  ${f.symbol} (${f.file}) — ${f.reachedVia} [${f.cutBy}]  →  seam --grow-from ${f.file}#${f.symbol}${q("")}`);
    if (model.frontierCut) out.push(`  (+${model.frontierCut} more decision point(s) cut by the cap — raise SEAM_FRONTIER_CAP)`);
    return out;
  };
  const gapsSection = (): string[] => {
    const out: string[] = [];
    const bs: any[] = model.blindspots ?? [];
    if (bs.length) {
      out.push("", "## Blindspots (what static resolution could not see — verify)");
      // SHARED-KEY-FANOUT boundaries are a CLASS, not individual leads — a coupling-heavy repo emits dozens
      // (`members` written in 17 files, `admin` in 7…). Rendered one-per-line they drown the exempt section and
      // blow the budget. COLLAPSE them to a summary that keeps the honest signal (count + the distinct keys +
      // the directive) without the flood. Non-fanout blindspots (real per-node leads) stay one-per-line.
      const FANOUT = new Set(["shared-key-fanout", "llm-proposed-key"]);
      const fanout = bs.filter((b) => FANOUT.has(b.mechanism));
      const ambient = new Map<string, string[]>();
      for (const b of bs) {
        if (FANOUT.has(b.mechanism)) continue;
        if (!(b.candidates ?? []).length) { (ambient.get(b.mechanism) ?? ambient.set(b.mechanism, []).get(b.mechanism)!).push(b.node); continue; }
        const cands = [...new Set((b.candidates ?? []).map((c: any) => c.symbol).filter(Boolean))].slice(0, 6);
        out.push(`  ${b.node}: ${b.mechanism} — ${b.evidence}${cands.length ? `; candidates: ${cands.join(", ")} (SUGGESTED)` : ""}`);
      }
      for (const [mech, nodes] of ambient) out.push(`  ${mech} — ${nodes.length} node(s)${nodes.length <= 4 ? `: ${nodes.join(", ")}` : ""}`);
      if (fanout.length) {
        const keyOf = (b: any) => (b.candidates ?? [])[0]?.symbol ?? (String(b.evidence ?? "").match(/'([^']+)'/)?.[1]) ?? b.node;
        const keys = [...new Set(fanout.map(keyOf).filter(Boolean))];
        out.push(`  ${fanout.length} shared-key boundary crossing(s) (data-flow, not calls) over: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? `, +${keys.length - 12} more` : ""}`
          + " — to follow one, run Seam again from the OTHER side with the key as the intent.");
      }
    }
    const un: any[] = model.unresolved ?? [];
    if (un.length) { out.push("", `## Unresolved (${un.length} edge(s) static analysis couldn't follow)`); for (const u of un.slice(0, 8)) out.push(`  ${u.node ?? "?"}: ${u.query ?? ""}${u.reason ? ` (${u.reason})` : ""}`); }
    return out;
  };

  // ---- assemble; degrade OFF → supporting → hub samples, never the exempt sections (I3) ----
  const assemble = (dropOff: boolean, dropSupporting: boolean, dropSamples: boolean): string[] =>
    [...header(), ...spineSection(), ...regionSection(dropOff, dropSupporting), ...hubsSection(dropSamples), ...frontierSection(), ...gapsSection()];
  const steps: [boolean, boolean, boolean][] = [[false, false, false], [true, false, false], [true, true, false], [true, true, true]];
  let out = assemble(...steps[0]);
  for (const step of steps) { out = assemble(...step); if (tok(out) <= budget) break; }   // first fitting crop level, else the most-cropped
  return out.join("\n");
}

// CONCERN RENDER (prototype) — a CENTER-first projection for plural "how is X managed?" questions, where the
// answer is a STAR (a shared mechanism + the interactions around it) not a linear flow. The center is found
// STRUCTURALLY: the node with the highest fan-in (most consumers) in the intent-region — on Acme, the
// `BookingsBean` every interaction delegates through. Its consumers (each walked up to its entry point) are the
// INTERACTIONS, ranked by intent tier. Pure projection of an already-grown model (no re-grow) — validates whether
// the star FRAMING reads better than the flow map on a concern; the full plan re-anchors the grow on the center.
export function renderConcern(model: any, opts: { intent?: string; tokenBudget?: number; centers?: { file: string; symbol: string }[] } = {}): string {
  if (!model || model.mode !== "codebase") return "(not a codebase seam model)";
  const cl = (model.clusters ?? [])[0];
  if (!cl) return "(empty footprint)";
  const seams: Seam[] = cl.seams ?? [];
  const hunkById = new Map<string, any>();
  const seamOf = new Map<string, Seam>();
  for (const s of seams) for (const h of (s.hunks ?? [])) if ((h as any).id != null) { hunkById.set(String((h as any).id), h); seamOf.set(String((h as any).id), s); }
  const edges = (model.edges ?? []) as any[];
  // fan-in (consumers) ignoring containment. `callIn` = only CALL/reference/import in-edges (NOT crossings) — the
  // entry walk climbs those, so a data-READ edge (boundary → reader) is never mistaken for a caller (which would
  // climb a coupling interaction UP into the boundary node).
  const inEdges = new Map<string, Set<string>>();     // node → all its consumers (for center fan-in)
  const callIn = new Map<string, Set<string>>();      // node → its CALL-graph callers only (for the entry walk)
  for (const e of edges) { if (e.kind === "contains") continue; const f = String(e.from), t = String(e.to);
    (inEdges.get(t) ?? inEdges.set(t, new Set()).get(t)!).add(f);
    if (!_CROSS_KINDS.has(e.kind)) (callIn.get(t) ?? callIn.set(t, new Set()).get(t)!).add(f); }
  // CENTER CLUSTER — a broad concern's shared MECHANISMS (a cluster of beans, not one). Honour the caller's cluster
  // (opts.centers); else detect one intent-weighted center as a fallback. Interactions are the consumers of ANY
  // mechanism + their coupling counterparts, so the star spans the whole cluster.
  const nodes = [...hunkById.keys()];
  if (!nodes.length) return "(empty region)";
  const fanIn = (id: string) => inEdges.get(id)?.size ?? 0;
  const centerRel = (id: string) => (hunkById.get(id)?.relevance ?? -1);
  const haveRel = nodes.some((id) => centerRel(id) >= 0);
  const onIntent = (id: string) => !haveRel || centerRel(id) >= 0.18;
  const byFan = (a: string, b: string) => (fanIn(b) - fanIn(a)) || (Number(!!hunkById.get(b).hub) - Number(!!hunkById.get(a).hub)) || ((hunkById.get(b).complexity ?? 0) - (hunkById.get(a).complexity ?? 0));
  const matchNode = (c: { file: string; symbol: string }) => nodes.find((id) => { const h = hunkById.get(id); return h?.file && String(h.file).replace(/^\.\//, "").endsWith(c.file.replace(/^\.\//, "")) && h?.label === c.symbol; });
  let centerIds: string[] = (opts.centers?.length ? [...new Set(opts.centers.map(matchNode).filter((x): x is string => !!x))] : [])
    .length ? [...new Set(opts.centers!.map(matchNode).filter((x): x is string => !!x))]
    : [(nodes.filter(onIntent).sort(byFan)[0]) ?? nodes.slice().sort(byFan)[0]];
  centerIds = centerIds.filter(Boolean).sort(byFan);
  const centerSet = new Set(centerIds);
  // The mechanism INCLUDES its own method nodes: a consumer that calls `bean.createBooking()` reaches the
  // mechanism through the METHOD node (`BookingsBean.createBooking`), not the class the center pick named — and
  // may never reference the class directly (an injected / parameter-passed bean), so scanning consumers of the
  // class alone MISSES it (Acme: `AcmeCheckBookingsService.createBooking` grown but not an interaction).
  // centerSet stays the DISPLAY set (the mechanism lines); mechNodes is the interaction boundary (a method is
  // never its own interaction, and the entry walk halts at any mechanism node).
  const centerLabels = new Set([...centerSet].map((c) => hunkById.get(c)?.label).filter(Boolean));
  const mechNodes = new Set<string>(centerSet);
  for (const id of nodes) { const h = hunkById.get(id); if (h?.enclosing && centerLabels.has(h.enclosing)) mechNodes.add(id); }
  const primary = hunkById.get(centerIds[0]);
  // INTERACTIONS = consumers of ANY mechanism (its class OR its methods), each walked UP to its entry point
  // (stopping at any mechanism), so a ray is named by its interaction. Deduped by entry.
  const entryOf = (start: string): string => {
    let cur = start; const seen = new Set<string>(mechNodes);
    for (let hop = 0; hop < 8; hop++) {
      if (seen.has(cur)) break; seen.add(cur);
      const callers = [...(callIn.get(cur) ?? [])].filter((c) => !seen.has(c));   // CALL-graph callers only (skip crossings)
      if (!callers.length) return cur;                 // no caller → an entry point (a coupling reader is its own entry)
      cur = callers.sort((a, b) => (fanIn(a) - fanIn(b)))[0];   // climb the least-shared caller (toward a specific entry)
    }
    return cur;
  };
  const tierRank = (s?: Seam) => (s?.tier === "spine" ? 0 : s?.tier === "off" ? 2 : 1);
  // QUALIFY a node for display with its owning class (`Class.method`) — DISPLAY only; the raw `label` stays bare
  // for the --grow-from handle + center-matching. Disambiguates a bare `createBooking` across sibling beans.
  const qual = (h: any): string => (h?.enclosing && h.enclosing !== h.label ? `${h.enclosing}.${h.label}` : (h?.label ?? "?"));
  // COUPLING interactions — a node sharing a data-key BOUNDARY with a mechanism (the bean writes a table a reporting
  // job READS → that job is an interaction though it never CALLS the bean). 2 hops over crossings; boundary skipped.
  const crossAdj = new Map<string, Set<string>>();
  for (const e of edges) { if (!_CROSS_KINDS.has(e.kind)) continue; const f = String(e.from), t = String(e.to);
    (crossAdj.get(f) ?? crossAdj.set(f, new Set()).get(f)!).add(t); (crossAdj.get(t) ?? crossAdj.set(t, new Set()).get(t)!).add(f); }
  // Rays are keyed by ENTRY (the least-shared caller a consumer climbs to), but MANY operations climb to the
  // same entry (createBooking/updateBooking/cancelBooking → an orchestrator `book`). Keeping ONE `via` per entry
  // hid all but the first — the dev saw `book` but not `createBooking` (Acme). ACCUMULATE the distinct
  // vias so the entry lists every operation reaching it: `via book, createBooking, updateBooking, …`.
  const rays = new Map<string, { entry: string; vias: Set<string> }>();   // entry id → {entry, the operations reaching a mechanism through it}
  const addRay = (entry: string, via: string) => { if (mechNodes.has(entry)) return; const r = rays.get(entry) ?? { entry, vias: new Set<string>() }; r.vias.add(via); rays.set(entry, r); };
  for (const cid of mechNodes)   // consumers of the mechanism's CLASS or any of its METHODS
    for (const consumer of (callIn.get(cid) ?? [])) { if (mechNodes.has(consumer)) continue; addRay(entryOf(consumer), qual(hunkById.get(consumer))); }
  // CROSS-STACK interactions — the boundary (a route/table/queue) can sit on an INTERMEDIATE that reaches the
  // mechanism (a REST endpoint the bean sits BEHIND), NOT on the center itself: a Java bean's JS front-end
  // consumer crosses the route to the ENDPOINT, never to the bean, so a center-only crossing scan hides it (the
  // cross-stack half is grown but invisible on the map — the whole point of Seam). Walk the mechanism's call-
  // UPSTREAM closure (every node that reaches a center through calls) and surface the crossing counterpart of ANY
  // of them. The boundary node (b) is skipped; the counterpart (y) is the interaction, walked up to its OWN
  // (front-end) entry — and if that entry climbed out of the grown region, surface the counterpart itself.
  const upstream = new Set<string>(mechNodes);
  const ust = [...mechNodes];
  while (ust.length) { const n = ust.pop()!; for (const c of (callIn.get(n) ?? [])) if (!upstream.has(c)) { upstream.add(c); ust.push(c); } }
  // the BOUNDARY nodes the mechanism sits on (the route/table/key sites, crossing-adjacent to the upstream); their
  // OTHER neighbours are the cross-stack counterparts (code sharing the boundary). Skip a boundary itself as a
  // counterpart — it's the medium, not an interaction (a `/route` or `table` node would render as a fake entry).
  const boundaries = new Set<string>();
  for (const n of upstream) for (const b of (crossAdj.get(n) ?? [])) boundaries.add(b);
  const _isSym = (l: unknown): l is string => typeof l === "string" && /^[A-Za-z_$][\w$]*$/.test(l);
  for (const b of boundaries) for (const y of (crossAdj.get(b) ?? [])) {
    if (upstream.has(y) || boundaries.has(y) || !hunkById.has(y)) continue;   // Java call-side / another boundary / non-region → not a counterpart
    let e = entryOf(y); const eh = hunkById.get(e); if (!eh?.file || !eh?.label) e = y;   // entry left the region → surface the counterpart node itself
    if (mechNodes.has(e) || upstream.has(e) || boundaries.has(e)) continue;
    // OPERATION-named boundaries: a DECLARATIVE endpoint-map client names its OP as the route node's label
    // (`updateBooking`) instead of a raw `/path`, and the ops fold into one code entry (`install`). Surface the
    // op NAMES as the via so the map shows what the client does — `via updateBooking`, not just `the /… boundary`.
    const ops = [...(crossAdj.get(y) ?? [])].map((r) => hunkById.get(r)).filter((rh) => rh?.kind === "route" && _isSym(rh.label));
    if (ops.length) for (const rh of ops) addRay(e, rh.label);
    else addRay(e, `the ${hunkById.get(b)?.label ?? "shared key"} boundary`);
  }
  // DROP dead entries — a ray whose entry node has no location (a synthetic boundary/blindspot node that leaked
  // in) would render as `? (?:0)` with a `--grow-from undefined#undefined` handle. Never emit those.
  const rayList = [...rays.values()].filter((r) => { const h = hunkById.get(r.entry); return h?.file && h?.label; }).sort((a, b) =>
    (tierRank(seamOf.get(a.entry)) - tierRank(seamOf.get(b.entry))) ||   // spine interactions first
    (centerRel(b.entry) - centerRel(a.entry)) ||                         // then most intent-relevant
    (String(hunkById.get(a.entry)?.label) < String(hunkById.get(b.entry)?.label) ? -1 : 1));
  // A grow-from handle needs a real SYMBOL. A file/module node's label is the filename (`provisioning.ts`), so
  // `file#provisioning.ts` is not a valid anchor — render the interaction, but omit the broken deepen handle.
  const symLike = (l: unknown): l is string => typeof l === "string" && /^[A-Za-z_$][\w$]*$/.test(l);
  const cap = Math.max(1, parseInt(process.env.SEAM_CONCERN_CAP ?? "20", 10) || 20);   // a big concern stays scannable
  const q = opts.intent ? ` --intent "${opts.intent}"` : "";
  const where = (h: any) => `${qual(h)} (${h?.file ?? "?"}:${h?.start ?? 0})`;
  // the operations reaching a mechanism through this entry, distinct, capped + counted (a fat orchestrator stays
  // scannable). The entry's OWN name (when it is itself a direct consumer) sorts first; other operations follow.
  const _VIA_CAP = Math.max(1, parseInt(process.env.SEAM_CONCERN_VIAS ?? "8", 10) || 8);
  const viasStr = (r: { entry: string; vias: Set<string> }): string => {
    const self = qual(hunkById.get(r.entry));
    const v = [...r.vias].sort((a, b) => (Number(b === self) - Number(a === self)) || (a < b ? -1 : 1));
    return v.slice(0, _VIA_CAP).join(", ") + (v.length > _VIA_CAP ? `, … (+${v.length - _VIA_CAP})` : "");
  };
  // DIAGNOSTIC (SEAM_FP_DEBUG): the FULL interaction list before the cap + which are CUT. "Why is X missing":
  // absent here = not enumerated (grow/coupling gap); present-but-CUT = raise SEAM_CONCERN_CAP; in a `via` list =
  // it reaches the mechanism through that entry (now shown, not silently folded away).
  if (process.env.SEAM_FP_DEBUG) {
    const w = (s: string) => process.stderr.write(s + "\n");
    w(`[concern] mechanisms: ${[...mechNodes].filter((c) => centerSet.has(c)).map((c) => qual(hunkById.get(c))).join(", ")} | +${mechNodes.size - centerSet.size} method node(s) in scope`);
    w(`[concern] interactions: ${rayList.length} enumerated, cap ${cap}`);
    rayList.forEach((r, i) => w(`[concern]   ${i < cap ? "show " : "CUT  "}${qual(hunkById.get(r.entry))} [${seamOf.get(r.entry)?.tier ?? "?"}] — via ${viasStr(r)}`));
    // GROWN-BUT-UNSHOWN: a code node in the footprint that is neither a mechanism/operation nor an interaction
    // (entry or folded via). Its callIn/cross counts say WHY: callIn=0 & cross=0 → an orphan the grow reached by
    // some other edge (not a call-consumer of the mechanism, not a crossing counterpart) → the concern is
    // center-centric and it isn't wired to the center; cross>0 → a coupling counterpart the boundary scan didn't
    // reach (its boundary isn't on the mechanism's upstream). This is the "AcmeCheckBookingsService / CRUD
    // route grown but absent" probe.
    const shownIds = new Set<string>([...mechNodes, ...rayList.map((r) => r.entry)]);
    for (const cid of mechNodes) for (const c of (callIn.get(cid) ?? [])) if (!mechNodes.has(c) && shownIds.has(entryOf(c))) shownIds.add(c);
    const unshown = nodes.filter((id) => { const h = hunkById.get(id); return h?.file && symLike(h.label) && !shownIds.has(id); });
    w(`[concern] grown-but-unshown code node(s): ${unshown.length}`);
    for (const id of unshown.slice(0, 60)) { const h = hunkById.get(id); w(`[concern]   unshown ${qual(h)} (${h.file}) [${seamOf.get(id)?.tier ?? "?"}] callIn=${callIn.get(id)?.size ?? 0} cross=${crossAdj.get(id)?.size ?? 0}`); }
  }
  const out: string[] = [];
  // MECHANISMS — render EVERY picked center (opts.centers), so the header count matches the pick. A center the
  // grow reached shows its fan-in; one the node budget didn't expand is still listed (picked, not reached) so the
  // agent knows it's part of the concern. Falls back to the detected centerIds when no centers were passed.
  // OPERATIONS — a mechanism is usually a CLASS/bean; its own METHODS present in the footprint (grown as its
  // deps) ARE the answer to "how is X managed" (createBooking / cancelBooking / …), but the center line only
  // names the class, so they were invisible — the dev saw a bare `BookingsBean` and none of its operations.
  // List the methods the region holds under each mechanism (structural: hunk.enclosing === the center's label),
  // capped + counted so a fat bean stays scannable. A leading `→` marks the intent-relevant ones (spine tier).
  const _OPS_CAP = Math.max(4, parseInt(process.env.SEAM_CONCERN_OPS ?? "16", 10) || 16);
  const opsOf = (label: string): string[] => {
    if (!label) return [];
    const ops: { name: string; spine: boolean }[] = [];
    const seen = new Set<string>();
    for (const id of nodes) { const hh = hunkById.get(id); if (hh?.enclosing === label && hh.label && !seen.has(hh.label)) { seen.add(hh.label); ops.push({ name: hh.label, spine: seamOf.get(id)?.tier === "spine" }); } }
    return ops.sort((a, b) => (Number(b.spine) - Number(a.spine)) || (a.name < b.name ? -1 : 1)).map((o) => (o.spine ? `→${o.name}` : o.name));
  };
  const mechLine = (h: any, cid: string | null): string => {
    const head = `  ${where(h)} — fan-in ${cid ? fanIn(cid) : 0} consumer(s)${h?.hub ? ` — hub (${h.hub.reason}, fan ${h.hub.fan})` : ""}`;
    const ops = opsOf(h?.label);
    return ops.length ? `${head}\n      operations: ${ops.slice(0, _OPS_CAP).join(", ")}${ops.length > _OPS_CAP ? `, … (+${ops.length - _OPS_CAP} more)` : ""}` : head;
  };
  const mechLines: string[] = [];
  if (opts.centers?.length) {
    for (const c of opts.centers) { const cid = matchNode(c); const h = cid ? hunkById.get(cid) : null;
      mechLines.push(h ? mechLine(h, cid) : `  ${c.symbol} (${c.file}) — picked, not reached in this region`); }
  } else for (const cid of centerIds) mechLines.push(mechLine(hunkById.get(cid), cid));
  const mechCount = opts.centers?.length ?? centerIds.length;
  out.push("# Concern map — the mechanisms and the interactions around them",
    [`concern: ${opts.intent ?? primary?.label ?? "?"}`, `mechanisms: ${mechCount}`, `resolution: ${model.resolutionQuality ?? "?"}`,
      `interactions: ${rayList.length}`, `blindspots: ${(model.blindspots ?? []).length}`].join(" | "));
  out.push("", `## Mechanisms (the concern's shared beans — the star's center${mechCount > 1 ? " cluster" : ""})`, ...mechLines);
  out.push("", "## Interactions (each entry point that uses a mechanism — deepen the ones that matter)");
  for (const r of rayList.slice(0, cap)) { const eh = hunkById.get(r.entry);
    const rel = seamOf.get(r.entry)?.tier ? ` [${seamOf.get(r.entry)!.tier}]` : "";
    const handle = symLike(eh?.label) ? `  →  seam --grow-from ${eh.file}#${eh.label}${q}` : "";   // file/module node → describe it, no broken deepen handle
    out.push(`  ${where(eh)}${rel} — reaches a mechanism via ${viasStr(r)}${handle}`); }
  if (rayList.length > cap) out.push(`  (+${rayList.length - cap} more interaction(s) — raise SEAM_CONCERN_CAP)`);
  // blindspots (reuse the fanout collapse idea, kept short)
  const bs = (model.blindspots ?? []) as any[];
  if (bs.length) { const keys = [...new Set(bs.map((b) => (b.candidates ?? [])[0]?.symbol ?? b.mechanism).filter(Boolean))];
    out.push("", `## Blindspots — ${bs.length} boundary/opaque site(s) over: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", …" : ""}`); }
  return out.join("\n");
}
