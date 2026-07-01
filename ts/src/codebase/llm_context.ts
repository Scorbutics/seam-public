// LLM-CONTEXT projection — a token-economical serialization of an emitted codebase seam model, for a
// DOWNSTREAM agent to consume (not a human to read). It is a pure PROJECTION of the same `seams.json`
// (no engine logic, no LLM) — the multi-client contract: one canonical model, many thin clients.
//
// It differs from the human renderings on exactly three principled axes (see docs/INTENT_CULMINATION…):
//   1. NO lossy collapsing — every off-path seam is listed (the "+N more dimmed" roll-up hides recall an
//      LLM could use); 2. CONFIDENCE not a boolean ★ — the climax is a ranked `culminationRanked` list, so
//      a consumer can hedge (the single-pick is fragile on backend flows); 3. token economy — paths +
//      roles + tables + blindspot candidates, never hunk bodies or render chrome.

type Hunk = { file?: string; role?: string; label?: string; start?: number; relevance?: number; spine?: boolean };
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
const _WAVE_VERB: Record<string, string> = {
  call: "called by", import: "used by", reference: "referenced by", "interface-impl": "implemented by",
  contains: "declared in", "route-serve": "via route from", "route-fetch": "via route from",
  "data-coupling": "shares data with", "type-ref": "typed by",
};
const _WAVE_RANK = (k: string): number => (k === "call" ? 0 : k === "route-serve" || k === "route-fetch" ? 1 : k === "import" || k === "reference" || k === "interface-impl" ? 2 : k === "contains" ? 4 : 3);
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

  // BOUNDARY nodes = the synthetic route standing BETWEEN a consumer and a handler (incident to a route-fetch AND
  // a route-serve). They orient the cross-stack hop but aren't participants themselves.
  const inc = new Map<string, Set<string>>();
  for (const e of (model.edges ?? []) as any[]) { for (const x of [e.from, e.to]) (inc.get(String(x)) ?? inc.set(String(x), new Set()).get(String(x))!).add(e.kind); }
  const isBoundary = (id: string) => { const k = inc.get(id); return !!k && k.has("route-serve") && k.has("route-fetch"); };

  // FORWARD GRAPH — ORIENTED by MEANING, not flood order: a call/contains/impl/import goes from→to as-is; a route
  // crossing (emitted symmetrically) is oriented consumer→boundary→handler by which end is the boundary. This
  // survives a sibling UI action reached AFTER the anchor (whose shell would mis-orient it). `contains` continues a
  // flow from a class into its method; it does NOT count as being "called", so a method stays a valid entry.
  const fwd = new Map<string, { to: string; kind: string }[]>();
  const callIn = new Map<string, number>();
  for (const id of node.keys()) callIn.set(id, 0);
  const addFwd = (f: string, t: string, kind: string) => { if (f === t || !node.has(f) || !node.has(t)) return; const a = fwd.get(f) ?? fwd.set(f, []).get(f)!; if (!a.some((o) => o.to === t && o.kind === kind)) a.push({ to: t, kind }); if (kind !== "contains") callIn.set(t, (callIn.get(t) ?? 0) + 1); };
  for (const e of (model.edges ?? []) as any[]) {
    const f = String(e.from), t = String(e.to);
    if (e.kind === "route-fetch") { const c = isBoundary(t) ? f : isBoundary(f) ? t : null, b = isBoundary(t) ? t : f; if (c) addFwd(c, b, e.kind); }        // consumer → boundary
    else if (e.kind === "route-serve") { const b = isBoundary(f) ? f : t, h = isBoundary(f) ? t : f; if (isBoundary(b)) addFwd(b, h, e.kind); }              // boundary → handler
    else if (_FWD_KINDS.has(e.kind)) addFwd(f, t, e.kind);
  }
  // ENTRY POINTS = each USER ACTION's departure, NOT the anchor: a non-boundary node that CONSUMES a route (has an
  // outgoing route-fetch — a UI/client action), OR a forward-root nothing in-region calls (a backend entry). Each
  // becomes its own scenario. On-intent first, deepest reach.
  const hasOut = (id: string) => (fwd.get(id)?.length ?? 0) > 0;
  const consumes = (id: string) => (fwd.get(id) ?? []).some((o) => o.kind === "route-fetch");
  const entries = [...node.keys()].filter((id) => !isBoundary(id) && hasOut(id) && (consumes(id) || (callIn.get(id) ?? 0) === 0));

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
    for (const step of path) {
      const c = contOf(step.id), id = _MERMAID_ID(c), info = node.get(step.id)!;
      if (!parts.includes(`${id}\t${c}`)) parts.push(`${id}\t${c}`);
      if (prev !== null && prev !== id) {
        const rel = _seqArrow[step.kind];
        const msg = info.label && info.label !== c && !info.label.startsWith("/") ? info.label : info.seam.label;
        msgs.push(`  ${prev}->>${id}: ${msg}${rel ? ` [${rel}]` : ""}`);
        hops.push(`${prev}>${id}`);
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
    "forward call/route graph to its deepest terminal; same-class steps share a lifeline, [HTTP] = over a route.");
  return out.join("\n");
}
