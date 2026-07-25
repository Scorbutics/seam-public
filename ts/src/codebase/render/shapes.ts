// STRUCTURAL SHAPES — deterministic query projections (consumers/dependencies/impact/compare/neighborhood/
// contract/reach), each a pure serialization of its shape's model (no engine logic, no LLM). Independent of
// the flood/wave/agent/concern render family in llm_context.ts — split out because they share no state with
// it beyond the model's own shape contract. See grow/{project_set,impact,compare,neighborhood,contract,reach}.ts.

// EDGE-SET projection — the flat, tier-grouped render shared by the consumers (`shape:"set"`, in-edges)
// and dependencies (`shape:"deps"`, out-edges) shapes. NOT numbered spine steps — a set has no order.
// Honest about the floor: resolved members are the verified answer; suggested are leads; the unresolved
// bucket is "grep these"; noStructure routes the asker away entirely. The two public renderers below fix
// the direction-specific wording. See grow/project_set.ts.
import { type SnippetReader } from "./snippets.js";

interface EdgeSetLabels { title: string; nounPl: string; noneText: string }

// CITATION — `file:line`, but NEVER a fabricated line. Every model this module renders carries 1-BASED lines
// (project_set's `to1` is the ONE conversion point, shared by consumers/dependencies/impact/reaches/writers/
// coupling), so this renders the value as-is. A projected `line` of 0 means "no real site was grounded" (see
// `to1`/`_start` + GraphNode.unlocated): that member is rendered as a bare path. Printing `:0`/`:1` there sends
// the reader to an unrelated line and destroys the one thing a structural citation is for. Every `file:line` in
// this module goes through here — a shape that formats its own `${file}:${line}` is how the rule gets lost.
// EXPORTED: the flood/wave/agent/concern family (llm_context.ts, render/vocab.ts) cites the SEAM MODEL, whose
// lines are 1-based too (`from_resolved_graph` converts at the codebase front — see core/lines.ts), so it must
// obey the SAME no-fabricated-line rule. It used to print `file:0` for an unlocated node; one helper, one rule.
export const at = (file: string, line: number | null | undefined): string => (line ? `${file}:${line}` : `${file}`);
// Same rule where the FILE is already stated by an enclosing group heading (impact's per-file rollup) and only
// the line is cited: a real line renders as ` (:582)`, a missing one renders as NOTHING. Sharing the falsy test
// with `at` is the point — one place decides what "no grounded line" looks like.
const atLine = (line: number | null | undefined): string => (line ? ` (:${line})` : "");

// SNIPPET BLOCK — the cited source text under a member line (opt-in `--snippets[=N]`; see render/snippets.ts).
// Rides the SAME citation the line above it printed (`at`/`atLine`, both fed by project_set's 1-based `to1`) —
// there is no second citation path, so a snippet can never disagree with the `file:line` it sits under. No
// reader (the default) or no grounded line ⇒ nothing at all.
const snip = (r: SnippetReader | undefined, file: string, line: number | null | undefined, indent?: string): string => {
  const ls = r ? r(file, line, indent) : [];
  return ls.length ? "\n" + ls.join("\n") : "";
};

// COUPLING TRUNCATION note (Seam's honesty contract) — the targeted bridge walks a key's candidate files in a
// TOTAL order and stops at READER_CAP complements (or the run's scan budget). Whenever it stopped before the
// list was exhausted the answer is a lower bound, so SAY so per key, with the grep that completes it — never
// present a bounded set as the whole truth. Shared by the edge-set and impact renderers (same model field).
function crossStackTruncationLines(truncs: any[] | undefined): string[] {
  if (!truncs?.length) return [];
  const out = [`## Cross-stack coupling is TRUNCATED (lower bound — more counterparts may exist)`];
  for (const t of truncs)
    out.push(`- ${t.kind} "${t.value}": scanned ${t.scanned} of ${t.total} candidate file(s)`
      + ` (${t.reason === "reader-cap" ? "reader cap reached — this key has more counterparts than Seam materialises" : "run scan budget exhausted"})`
      + `; grep -F "${t.value}" for the full set`);
  out.push("");
  return out;
}

function renderEdgeSet(model: any, L: EdgeSetLabels, sr?: SnippetReader): string {
  const members: any[] = model.members ?? [];
  const unresolved: any[] = model.unresolved ?? [];
  const recalled: any[] = model.recalled ?? [];
  const crossStack: any[] = model.crossStack ?? [];
  const resolved = members.filter((m) => m.provenance !== "SUGGESTED");
  const suggested = members.filter((m) => m.provenance === "SUGGESTED");
  const out: string[] = [];
  const head = [`anchor: ${model.anchor?.symbol ?? "?"}`, `shape: ${model.shape}`, `resolution: ${model.resolutionQuality ?? "?"}`,
    `resolved: ${resolved.length}`, `suggested: ${suggested.length}`, `unresolved: ${unresolved.length}`,
    ...(recalled.length ? [`recalled: ${recalled.length}`] : []),
    ...(crossStack.length ? [`cross-stack: ${crossStack.length}`] : [])];
  out.push(`# ${L.title} ${model.anchor?.symbol ?? "?"}`, head.join(" | "), "");

  // noStructure — the honest negative. Say it plainly and route to grep; do NOT pad with a half-answer.
  if (model.noStructure) {
    out.push(model.reason === "opaque"
      ? `## No resolved ${L.nounPl}\n${L.nounPl[0].toUpperCase() + L.nounPl.slice(1)} exist but none resolve structurally`
        + " (opaque imports / dynamic dispatch). This is a grep/LSP question — Seam can't verify the edges here."
      : `## No ${L.nounPl}\n${L.noneText}`);
    out.push("");
  }

  // OPTIONAL DI-binding line (SEAM_DI_RESOLVE): when a resolved member is a container-bound concrete impl, say
  // HOW it's wired — token + binding site, and for a selecting factory whether THIS impl is the conditional or
  // the fallback branch. This is the interface→impl→binding hop surfaced inline (no follow-up grep).
  const bindLine = (m: any): string => {
    const b = m.binding; if (!b) return "";
    const isImpl = (b.impls ?? []).includes(m.symbol);   // member is a concrete impl vs the interface (aggregate)
    if (b.kind === "toFactory" && (b.impls?.length ?? 0) > 1) {
      if (isImpl) {
        const sel = m.symbol === b.impls[0] ? `when (${b.condition ?? "?"})` : "otherwise (fallback)";
        return `\n    ↳ DI: token ${b.token} — bound via toFactory @ ${b.file}:${b.line}; this impl selected ${sel}`;
      }
      // interface type-ref → show the full branch: which impl runs when, which is the fallback
      const branch = b.impls.map((c: string, i: number) => i === 0 ? `${c} when (${b.condition ?? "?"})` : `${c} otherwise`);
      return `\n    ↳ DI: token ${b.token} — bound via toFactory @ ${b.file}:${b.line} → ${branch.join(" · ")}`;
    }
    const impl = !isImpl && (b.impls?.length ?? 0) ? ` → ${b.impls.join("/")}` : "";
    return `\n    ↳ DI: token ${b.token} — bound via ${b.kind} @ ${b.file}:${b.line}${impl}`;
  };
  // provenance (when shown) rides the member's OWN line; the DI-binding block comes UNDER it.
  const member = (m: any, prov?: string): string =>
    `- ${m.symbol} (${at(m.file, m.line)})  [${m.kind}, ${m.edgeKind}]${m.enclosing ? `  in ${m.enclosing}` : ""}`
    + (prov ? `  {${prov}}` : "") + bindLine(m) + snip(sr, m.file, m.line);
  if (resolved.length) {
    out.push(`## Resolved ${L.nounPl} (verified edges)`);
    for (const m of resolved) out.push(member(m, m.provenance));
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
  // CROSS-STACK COUPLING (the moat) — shared-key readers/writers of the anchor's data boundary. NOT a call/import
  // edge (grep/RAG can't link a backend write to its frontend reader); the coupling runs through a table/route/event.
  if (crossStack.length) {
    out.push(`## Cross-stack coupling (shared-key readers/writers — no import/call edge; grep can't link these; verify)`);
    for (const c of crossStack) out.push(`- ${c.symbol} (${c.file})  [${c.edgeKind} · via ${c.via}]  {RESOLVED_PARTIAL}`);
    out.push("");
  }
  out.push(...crossStackTruncationLines(model.crossStackTruncations));
  out.push("## How to use",
    `Resolved ${L.nounPl} are the verified set (correct where grep yields false positives from`,
    `comments/strings/same-name symbols). Suggested ${L.nounPl} are leads the resolver couldn't ground.`,
    `Unresolved ${L.nounPl} are opaque to static analysis — grep is the right tool for those.`,
    ...(recalled.length ? [`Recalled ${L.nounPl} use the symbol NAME in a code position but aren't import-verified`,
      "(a same-named symbol elsewhere can match) — they recover edges in languages without symbol imports",
      "(Ruby globals, C/C++), but confirm each before trusting."] : []));
  return out.join("\n");
}

// WRITERS (`shape:"writers"`) — REVERSE data-coupling: every repo-wide write site of the DB table(s) the anchor
// READS. Not an edge-set projection (no call/import edge links a shared-table writer to the reader), so it renders
// its own block, grouped implicitly by table via the per-member `writes "<table>"` tag. Honest about its grain.
export function renderWritersSet(model: any, sr?: SnippetReader): string {
  if (!model || model.shape !== "writers") return "(not a writers-set model)";
  const members: any[] = model.members ?? [];
  const tables: string[] = model.tables ?? [];
  const out: string[] = [];
  const filterCols: Record<string, string[]> = model.filterColumns ?? {};
  const filterDesc = Object.keys(filterCols).length
    ? Object.entries(filterCols).map(([t, cs]) => `${t}.{${(cs as string[]).join(",")}}`).join(" ") : "";
  out.push(`# Writers of the state ${model.anchor?.symbol ?? "?"} reads`,
    `anchor: ${model.anchor?.symbol ?? "?"} | shape: writers | tables: ${tables.map((t) => `"${t}"`).join(", ") || "none"}`
    + (model.columnGrain && filterDesc ? ` | reader filters on: ${filterDesc}` : "") + ` | write-sites: ${members.length}`, "");
  if (model.noStructure) {
    out.push(model.reason === "none"
      ? `## No DB table read here\n${model.anchor?.symbol ?? "?"} reads no resolvable DB table — there is no shared-state (table) coupling to reverse. This is a grep question.`
      : `## No writers resolved\nThe table(s) are read here, but no writer grounded in the coupling floor (opaque writes — grep the table name).`);
    return out.join("\n");
  }
  const colGrain = model.columnGrain && Object.keys(filterCols).length;
  out.push(colGrain
    ? `## Write sites (deterministic — writers of the COLUMN(S) the anchor filters on; a "col?" writer's columns were unparseable so it's kept unverified)`
    : `## Write sites (repo-wide, deterministic — every method that writes the table(s) the anchor reads)`);
  for (const m of members) {
    const cols = (m.columns?.length) ? `.{${m.columns.join(",")}}` : (colGrain && !m.colVerified ? " col?" : "");
    out.push(`- ${m.symbol} (${at(m.file, m.line)})  [${m.kind}, writes "${m.table}"${cols}]  {${m.provenance}}`
      + snip(sr, m.file, m.line));
  }
  out.push("", "## How to use",
    "These are the resolved writers of the shared state this anchor reads — the coupling runs through these table",
    "writes (no import/call edge links them to the reader, so grep-by-symbol can't find them as a set).",
    ...(colGrain
      ? ["COLUMN-GRAINED: a writer is listed only if it writes a column the reader FILTERS on (shown as `.{cols}`).",
         "A `col?` writer's argument columns couldn't be parsed, so it's kept but unverified — confirm it by hand.",
         "Set SEAM_WRITERS_COLUMNS=0 for the broader table-level set."]
      : ["TABLE-grained (the floor keys tables, not columns): crop to the writers relevant to your intent."]));
  return out.join("\n");
}

// COUPLING (`shape:"coupling"`) — the anchor's DATA BOUNDARY: every shared key it reads/writes, and per key the
// counterpart sites on the other side. The moat's front door: these pairs share no import, no call, and often no
// literal token — grep and RAG structurally cannot link them; only the resolved key can.
export function renderCoupling(model: any, sr?: SnippetReader): string {
  if (!model || model.shape !== "coupling") return "(not a coupling model)";
  const keys: any[] = model.keys ?? [];
  const out: string[] = [];
  out.push(`# Coupling of ${model.anchor?.symbol ?? "?"} (cross-stack data boundary)`,
    `anchor: ${model.anchor?.symbol ?? "?"} | shape: coupling | shared keys: ${keys.length} | counterpart sites: ${model.total ?? 0}`, "");
  if (model.noStructure) {
    out.push(model.reason === "none"
      ? `## No shared key\n${model.anchor?.symbol ?? "?"} touches no db-table / http-route / event boundary — it has no cross-stack coupling. Its dependencies are plain code edges (use --query dependencies).`
      : `## No counterparts\nThe anchor touches shared key(s), but no counterpart site grounded in the coupling floor — nothing else in the repo reads/writes them (or the accesses are opaque).`);
    return out.join("\n");
  }
  for (const k of keys) {
    out.push(`## ${k.kind} "${k.value}"  — anchor ${k.anchorRole}`);
    if (!k.sides.length) out.push(`  (no counterpart — the anchor is the only side of this key in the repo)`);
    for (const s of k.sides) {
      const cols = s.columns?.length ? `.{${s.columns.join(",")}}` : "";   // column grain (subsumes the writers shape)
      out.push(`  ${s.role === "writes" ? "←" : "→"} ${s.symbol} (${at(s.file, s.line)})  [${s.kind}, ${s.role} ${k.value}${cols}]`
        + snip(sr, s.file, s.line, "        "));
    }
    out.push("");
  }
  out.push("## How to use",
    "Each block is ONE shared key and the sites on the other side of it. `←` writes the key the anchor reads",
    "(a change there changes what the anchor sees); `→` reads what the anchor writes (a change here ripples there).",
    "NO import or call edge links these to the anchor — they meet only through the key, so a call-graph, grep, and",
    "semantic search all miss them. Grain is the key (a table, not a column), and provenance is RESOLVED_PARTIAL:",
    "the access is grounded, but confirm the specific field/branch matters to your change.");
  return out.join("\n");
}

// CONSUMERS (`shape:"set"`) — who calls/uses the anchor (in-edges).
export function renderConsumerSet(model: any, sr?: SnippetReader): string {
  if (!model || model.shape !== "set") return "(not a consumer-set model)";
  return renderEdgeSet(model, { title: "Consumers of", nounPl: "callers",
    noneText: "Nothing in the repo calls this symbol — an entry point, dead code, or dispatched-only." }, sr);
}

// DEPENDENCIES (`shape:"deps"`) — what the anchor calls/uses (out-edges).
export function renderDependencySet(model: any, sr?: SnippetReader): string {
  if (!model || model.shape !== "deps") return "(not a dependency-set model)";
  return renderEdgeSet(model, { title: "Dependencies of", nounPl: "dependencies",
    noneText: "This symbol uses nothing resolvable — a leaf (no outgoing dependencies)." }, sr);
}

// REFACTOR-FACTS bundle — "how to refactor X": the FACTS (impact + dependencies + contract) stitched
// together so a planner has the whole structural picture. The PLAN itself is NOT here — it's a judgement
// for the model/human to make over these facts. See grow/refactor_facts.ts.
export function renderRefactorFacts(model: any, sr?: SnippetReader): string {
  if (!model || model.shape !== "refactor") return "(not a refactor-facts model)";
  const sym = model.anchor?.symbol ?? "?";
  const im = model.impact ?? {}, dep = model.dependencies ?? {}, ct = model.contract ?? {};
  const out: string[] = [];
  out.push(`# Refactor facts for ${sym} (${model.anchor?.file ?? "?"})`,
    [`impact: ${im.total ?? 0} across ${im.fileCount ?? 0} file(s)${im.gaps?.length ? `, ${im.gaps.length} gap(s)` : ""}`,
     `dependencies: ${(dep.members ?? []).length}`,
     `contract: ${(ct.provides ?? []).length} provided, ${(ct.unusedExports ?? []).length} unused`].join(" | "),
    "", "These are the FACTS to plan a change to " + sym + " — the change PLAN over them is yours to make.", "");
  out.push("─".repeat(4) + " IMPACT (what breaks if you change it) " + "─".repeat(4), renderImpact(im, sr), "");
  out.push("─".repeat(4) + " DEPENDENCIES (what it uses) " + "─".repeat(4), renderDependencySet(dep, sr), "");
  out.push("─".repeat(4) + " CONTRACT (its boundary) " + "─".repeat(4), renderContract(ct));
  return out.join("\n");
}

// IMPACT projection — the transitive blast radius: the affected symbols (hop-sorted), a file rollup, the
// SURFACE (outermost callers — where the change ripples to), and the GAPS (opaque callers where the view
// is incomplete). The refactoring safety net. See grow/impact.ts.
export function renderImpact(model: any, sr?: SnippetReader): string {
  if (!model || model.shape !== "impact") return "(not an impact model)";
  const sym = model.anchor?.symbol ?? "?";
  const out: string[] = [];
  out.push(`# Impact of ${sym} (change blast radius)`,
    [`impacted: ${model.total}`, `files: ${model.fileCount}`, `surface: ${(model.surface ?? []).length}`,
     ...((model.crossStack ?? []).length ? [`cross-stack: ${model.crossStack.length}`] : []),
     `gaps: ${(model.gaps ?? []).length}`, ...(model.truncated ? ["truncated: yes (impact ≥ shown)"] : [])].join(" | "), "");
  if (model.noStructure) {
    out.push("## Isolated", model.reason === "opaque"
      ? `${sym} has no RESOLVED consumers, but ${(model.gaps ?? []).length} opaque caller(s) exist — verify those before assuming it's safe to change (see gaps below).`
      : `${sym} has no consumers in the repo — changing it is isolated (an entry point, dead code, or dispatched-only).`);
    if ((model.gaps ?? []).length) { out.push("", "## Gaps (opaque callers — grep these)"); for (const g of model.gaps) out.push(`- ${g.mechanism} — ${g.evidence}`); }
    return out.join("\n");
  }
  // Affected, grouped by file (most-affected first), with hop distance per symbol.
  // HUB CAP — a ubiquitous anchor has a blast radius nobody can read: Keycloak's AccessToken enumerates 6489
  // symbols across 2413 files, rendering ~147k tokens, which is more than the whole rest of a 30-intent run
  // put together. The MODEL keeps everything (--emit-seams is unaffected); only this human/agent-facing render
  // is bounded, and it says exactly what it elided so the reader is never misled into thinking the set is small.
  // Nearest hops are kept — they're the sites a change actually has to touch. `SEAM_IMPACT_RENDER_CAP=0` = unbounded.
  const capOf = (env: string, dflt: number) => { const v = parseInt(process.env[env] ?? "", 10); return Number.isFinite(v) ? v : dflt; };
  const cap = capOf("SEAM_IMPACT_RENDER_CAP", 1);                      // 0 disables ALL the caps below
  const FILES = cap ? capOf("SEAM_IMPACT_FILE_CAP", 60) : 0;
  const PER_FILE = cap ? capOf("SEAM_IMPACT_SYMS_PER_FILE", 12) : 0;
  const SURFACE = cap ? capOf("SEAM_IMPACT_SURFACE_CAP", 40) : 0;
  const byHop = (a: any, b: any) => (a.hop ?? 0) - (b.hop ?? 0) || String(a.symbol).localeCompare(String(b.symbol));

  const files: any[] = model.files ?? [];
  const shownFiles = FILES ? files.slice(0, FILES) : files;
  out.push("## Affected (by file — update these)");
  for (const f of shownFiles) {
    out.push(`- ${f.file}  (${f.count})`);
    const syms = (model.impacted ?? []).filter((x: any) => x.file === f.file).sort(byHop);
    const shown = PER_FILE ? syms.slice(0, PER_FILE) : syms;
    for (const m of shown) out.push(`    ${m.symbol}${atLine(m.line)} [${m.kind}, hop ${m.hop}]` + snip(sr, f.file, m.line, "        "));
    if (syms.length > shown.length) out.push(`    … +${syms.length - shown.length} more in this file (nearest hops shown)`);
  }
  if (files.length > shownFiles.length) {
    const rest = files.slice(shownFiles.length);
    const restSyms = rest.reduce((n: number, f: any) => n + (f.count ?? 0), 0);
    out.push(`- … +${rest.length} more file(s), ${restSyms} symbol(s) — elided from this render, not from the impact set`,
      `  (counts above are complete; --emit-seams carries every entry, SEAM_IMPACT_RENDER_CAP=0 prints them all)`);
  }
  out.push("");
  if ((model.surface ?? []).length) {
    out.push("## Surface (outermost callers — where the change ripples to; re-verify here)");
    const surf: any[] = model.surface;
    const shownSurf = SURFACE ? surf.slice(0, SURFACE) : surf;
    for (const m of shownSurf) out.push(`- ${m.symbol} (${at(m.file, m.line)})` + snip(sr, m.file, m.line));
    if (surf.length > shownSurf.length) out.push(`- … +${surf.length - shownSurf.length} more outermost caller(s) — elided from this render`);
    out.push("");
  }
  if ((model.crossStack ?? []).length) {
    out.push("## Cross-stack (shared-key readers/writers — grep can't link these; verify)");
    for (const c of model.crossStack) out.push(`- ${c.symbol} (${c.file})  [${c.edgeKind} · ${c.via}]`);
    out.push("");
  }
  out.push(...crossStackTruncationLines(model.crossStackTruncations));
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
     `reachable: ${model.reachable ? "yes" : "no"}${model.viaCoupling ? " (via data coupling)" : ""}`, `reason: ${model.reason}`, `explored: ${model.hops} hop(s)`].join(" | "), "");
  if (model.reachable) {
    // A path that crosses shared state is a REAL connection but NOT a call chain — never conflate the two.
    if (model.viaCoupling) out.push("> NOTE: this path crosses a DATA-COUPLING hop (a shared table/route one side"
      + " writes and the other reads). The connection is real but runs through STATE, not a call/import edge —"
      + " nothing links them textually, so grep/a call-graph would report 'no path'. Verify the marked step.", "");
    out.push("## Witness path (resolved edges, in order)");
    (model.path ?? []).forEach((s: any, i: number) => out.push(`${i + 1}. ${s.symbol} (${at(s.file, s.line)})${s.edgeKind && s.edgeKind !== "anchor" ? `  [${s.edgeKind}]` : "  [anchor]"}`));
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
