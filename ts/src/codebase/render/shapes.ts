// STRUCTURAL SHAPES — deterministic query projections (consumers/dependencies/impact/compare/neighborhood/
// contract/reach), each a pure serialization of its shape's model (no engine logic, no LLM). Independent of
// the flood/wave/agent/concern render family in llm_context.ts — split out because they share no state with
// it beyond the model's own shape contract. See grow/{project_set,impact,compare,neighborhood,contract,reach}.ts.

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
