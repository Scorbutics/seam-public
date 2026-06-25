// DIRECT ANCHOR PICK — the LLM names the entry point in ONE pass from rich candidate PASSAGES, with no
// probe sweep. The probe→judge path grows a footprint for ≤16 candidates SEQUENTIALLY (measured ~34 s of a
// ~47 s anchor pick on Dubbo) just to give the judge structural facts + verify connectedness. But the
// candidate POOL is built deterministically (embed recall ∪ lexical, no probing), and we GROW from the
// chosen anchor anyway — so the grow itself is the connectedness check. This collapses 3 anchor LLM passes
// (entrypoint-select + intent-expand + judge) + 16 probes → 1 LLM pick. The pick reads each candidate's
// PASSAGE (declaration + enclosing + file path + doc — the same signal embedScoreDefs ranks on; the path
// carries the domain words). Degrades to none when no LLM / no candidates (caller falls back to probe→judge).
import { verbose, emit } from "../../core/progress.js";
import { available, run_pass, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { embedScoreDefs } from "../scan/def_embed.js";
import { type Def } from "../scan/def_table.js";
import { find_anchor_candidates, _content_words } from "./anchor_rank.js";
import { type ProbedAnchor } from "./anchor_select.js";
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";

const PASS = registerPass({ tag: "anchor-pick", tier: "strong", note: "direct anchor selection from candidate passages (no probe)" });

const _NON_ANCHOR = new Set(["interface", "type", "enum"]);   // data shapes, never a starting point
const EMBED_TOP = 28;   // rich (Def-carrying) embed candidates — wide enough that a sibling module (a
const POOL_CAP = 44;    // monorepo's web-x vs web-y) still reaches the judge to honor a scope constraint

// The candidate's embed PASSAGE — declaration + enclosing + file path + doc. The path is the domain signal.
function passage(d: Def): string {
  const encl = d.enclosing ? ` in ${d.enclosing}` : "";
  const doc = d.doc ? ` :: ${d.doc}` : "";
  return `${d.signature || d.name}${encl} — ${d.file}${doc}`;
}

export type Cand = { name: string; file: string; kind: string; def?: Def };
// Build the candidate pool (NO LLM, pure → testable): embed top-K ∪ lexical floor, deduped by name|file,
// data-shapes (interface/type/enum) dropped, capped. Each embed-top def enters AS ITSELF — a strongly-
// matching METHOD enters as the method with its OWN signature+doc passage. Collapsing a method to its
// enclosing class used to bury the signal: `sendParaplanningRequestEmail` became `FileNoteService` (doc-less
// class passage) so the LLM couldn't see the "paraplanning" words and picked a worse candidate it COULD read.
// Anchoring on the method is precisely what works when you pass --symbol explicitly; the grow follows it the same way.
export function assembleCandidatePool(scored: { def: Def }[], lexical: { name: string; file: string; kind: string }[]): Cand[] {
  const defByKey = new Map<string, Def>(), defByName = new Map<string, Def>();
  for (const { def } of scored) {
    const k = `${def.name}|${def.file}`;
    if (!defByKey.has(k)) defByKey.set(k, def);
    if (!defByName.has(def.name)) defByName.set(def.name, def);
  }
  const pool: Cand[] = [], have = new Set<string>();
  const add = (name: string, file: string, kind: string, def?: Def) => {
    const k = `${name}|${file}`;
    if (have.has(k) || _NON_ANCHOR.has(kind)) return;
    have.add(k); pool.push({ name, file, kind, def });
  };
  for (const { def } of scored.slice(0, EMBED_TOP)) add(def.name, def.file, def.kind, def);
  for (const c of lexical) add(c.name, c.file, c.kind, defByKey.get(`${c.name}|${c.file}`) ?? defByName.get(c.name));
  return pool.slice(0, POOL_CAP);
}

// FAN-IN — how many files reference each candidate symbol by name. A symbol used across MANY files is
// INFRASTRUCTURE (a hub/utility), a poor anchor: an entry point has few callers, a hub yields a generic
// footprint AND an explosive grow. One repo walk, a single word-boundary alternation regex, size-capped —
// cheap next to the embed pass anchor selection already runs. (Comments/strings inflate slightly; the
// RELATIVE threshold in demoteHubs absorbs it.) Names <4 chars are skipped — too ambiguous to count.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function fanInByName(repo: string, names: string[]): Map<string, number> {
  const fan = new Map<string, number>(names.map((n) => [n, 0]));
  const distinct = [...new Set(names.filter((n) => n.length >= 4))];
  if (!distinct.length) return fan;
  const re = new RegExp(`\\b(?:${distinct.map(escapeRe).join("|")})\\b`, "g");
  for (const { text } of walkFiles(repo, SKIP_DIRS, endsWithSourceExt, { maxBytes: 1_000_000 })) {
    const seen = new Set<string>();
    let m: RegExpExecArray | null; re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) seen.add(m[0]);
    for (const n of seen) fan.set(n, (fan.get(n) ?? 0) + 1);
  }
  return fan;
}

// DEMOTE HUBS — drop candidates referenced in far more files than the pool norm (infrastructure used
// everywhere — the wrong anchor). RELATIVE threshold so it adapts to the repo (no magic absolute count):
// a hub = fan-in ≥ max(HUB_FLOOR, HUB_MULT × pool median). Hubs are dropped ONLY while ≥ MIN_KEEP non-hub
// candidates remain, so a footprint of genuinely-central symbols is never emptied. Pure → unit-testable.
const _HUB_FLOOR = 8, _HUB_MULT = 4, _MIN_KEEP = 5;
export function demoteHubs(cand: Cand[], fanIn: Map<string, number>): Cand[] {
  if (cand.length <= _MIN_KEEP) return cand;
  const fans = cand.map((c) => fanIn.get(c.name) ?? 0).sort((a, b) => a - b);
  const median = fans[Math.floor(fans.length / 2)] || 0;
  const bar = Math.max(_HUB_FLOOR, _HUB_MULT * median);
  const nonHub = cand.filter((c) => (fanIn.get(c.name) ?? 0) < bar);
  return nonHub.length >= _MIN_KEEP ? nonHub : cand;   // keep all if dropping would starve the pool
}

export type AnchorAlt = { name: string; file: string; score: number };
// The runner-up anchors (pool minus the chosen) ranked by intent-embed score. Surfaced so an off-intent
// footprint can OFFER a better-matching anchor to re-run on, instead of silently presenting the wrong flow.
// Pure → testable. Their scores ALSO disambiguate "wrong pick" (an alt scores high) from "intent has no home
// here" (all alts score low) for free.
export function rankAlternatives(cand: Cand[], scored: { def: Def; score: number }[], chosen: { name: string; file: string } | null, cap = 5): AnchorAlt[] {
  const sc = new Map<string, number>();
  for (const { def, score } of scored) { const k = `${def.name}|${def.file}`; if (!sc.has(k)) sc.set(k, score); }
  return cand
    .filter((c) => !(chosen && c.name === chosen.name && c.file === chosen.file))
    .map((c) => ({ name: c.name, file: c.file, score: sc.get(`${c.name}|${c.file}`) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap);
}

// The judge prompt — pure (intent + candidates → lines), so the SCOPE contract is testable: every
// candidate carries its file path, and the model is told to treat a developer-named location (a module /
// app / directory / path to USE or AVOID) as a HARD constraint. Detecting that the developer meant a scope
// is a SEMANTIC read of free text → the model's job (a path filter would die on phrasing/typos); the path
// is right there in each candidate for it to apply.
export function _pick_prompt(intent: string, cand: Cand[]): string[] {
  const lines = [
    `A developer asks: "${intent}". Pick the SINGLE best STARTING POINT to answer it — the symbol whose`,
    "code is the mechanism/entry the question is about (where you'd start reading the flow), NOT a leaf",
    "helper, a test, or a class that merely participates. Each candidate shows its declaration, enclosing",
    "class, file path, and doc-comment — judge by what it IS and DOES, matched to the question (the name",
    "alone can mislead; the path is a strong hint).",
    "If the question names a MODULE, APP, DIRECTORY, or PATH to use or to AVOID (e.g. \"only in web-x\",",
    "\"not from web-y\"), treat it as a HARD constraint: NEVER pick a candidate whose file path violates it,",
    "even if a violating one looks more relevant. Pick the best among the candidates the constraint allows.",
    "",
  ];
  cand.forEach((c, i) => lines.push(`  c${i}: ${c.def ? passage(c.def) : `${c.name} — ${c.file}`}`));
  lines.push("", 'Output ONLY a JSON array, one object per candidate: [{"id":"c<n>","best":true|false}] with `best` true for exactly ONE.');
  return lines;
}

export async function pick_anchor(repo: string, intent: string, opts: { model?: string; claudeBin?: string | null } = {}):
    Promise<{ chosen: ProbedAnchor | null; chosenBy: "pick" | "none"; alternatives?: AnchorAlt[] }> {
  if (!available(opts.claudeBin)) return { chosen: null, chosenBy: "none" };

  emit("Recalling candidate anchors by intent (embeddings)…");
  const scored = await embedScoreDefs(repo, intent);   // [] when embeddings absent → caller falls back
  const pooled = assembleCandidatePool(scored, find_anchor_candidates(repo, [..._content_words(intent)]));
  const fanIn = fanInByName(repo, pooled.map((c) => c.name));
  const cand = demoteHubs(pooled, fanIn);              // a hub anchor (used everywhere) → generic result + slow grow
  if (!cand.length) return { chosen: null, chosenBy: "none" };

  // DIAGNOSTIC (--verbose, or the narrow SEAM_ANCHOR_DEBUG): dump the embed ranking + the candidate pool so
  // we can see whether the RIGHT anchor was even recalled (and at what rank), and what PASSAGE the LLM judged
  // it on. Reveals the method→enclosing-class collapse (a method's intent words vanish behind its class's doc).
  if (verbose() || process.env.SEAM_ANCHOR_DEBUG) {
    const rankByKey = new Map(scored.map(({ def }, i) => [`${def.name}|${def.file}`, i]));
    const e = process.stderr;
    e.write(`\n[anchor-debug] intent: "${intent}"\n[anchor-debug] embed-ranked defs (top 30 of ${scored.length}):\n`);
    scored.slice(0, 30).forEach(({ def, score }, i) => e.write(`   #${i} ${score.toFixed(3)} ${def.name}${def.enclosing ? " in " + def.enclosing : ""} (${def.file})\n`));
    const dropped = pooled.filter((p) => !cand.includes(p));
    if (dropped.length) e.write(`[anchor-debug] dropped as HUBS: ${dropped.map((c) => `${c.name}(fan-in ${fanIn.get(c.name) ?? 0})`).join(", ")}\n`);
    e.write(`[anchor-debug] candidate pool (${cand.length}):\n`);
    cand.forEach((c, i) => e.write(`   c${i} ${c.name} (fan-in ${fanIn.get(c.name) ?? 0}) (${c.file})${c.def ? ` [embed#${rankByKey.get(`${c.def.name}|${c.def.file}`) ?? "?"}] passage: ${passage(c.def).slice(0, 160)}` : " [lexical]"}\n`));
  }

  const lines = _pick_prompt(intent, cand);

  let out: Map<string, any>;
  emit(`Judging the entry point among ${cand.length} candidate(s) (LLM)…`);
  try { out = run_pass(lines.join("\n"), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag }); }
  catch (e) { if (e instanceof LLMError) return { chosen: null, chosenBy: "none" }; throw e; }

  for (let i = 0; i < cand.length; i++) {
    const o = out.get(`c${i}`);
    if (o && typeof o === "object" && [true, "true", "True"].includes(o.best)) {
      const c = cand[i];
      if (verbose() || process.env.SEAM_ANCHOR_DEBUG) process.stderr.write(`[anchor-debug] LLM picked c${i}: ${c.name} (${c.file})\n`);
      return {
        chosen: { id: `c${i}`, name: c.name, file: c.file, kind: c.kind, score: 0, terms: ["~pick"],
                  metrics: null, structScore: 0, signature: c.def?.signature, doc: c.def?.doc },
        chosenBy: "pick",
        alternatives: rankAlternatives(cand, scored, c),
      };
    }
  }
  return { chosen: null, chosenBy: "none" };
}
