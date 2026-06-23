// DIRECT ANCHOR PICK — the LLM names the entry point in ONE pass from rich candidate PASSAGES, with no
// probe sweep. The probe→judge path grows a footprint for ≤16 candidates SEQUENTIALLY (measured ~34 s of a
// ~47 s anchor pick on Dubbo) just to give the judge structural facts + verify connectedness. But the
// candidate POOL is built deterministically (embed recall ∪ lexical, no probing), and we GROW from the
// chosen anchor anyway — so the grow itself is the connectedness check. This collapses 3 anchor LLM passes
// (entrypoint-select + intent-expand + judge) + 16 probes → 1 LLM pick. The pick reads each candidate's
// PASSAGE (declaration + enclosing + file path + doc — the same signal embedScoreDefs ranks on; the path
// carries the domain words). Degrades to none when no LLM / no candidates (caller falls back to probe→judge).
import { available, run_pass, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { embedScoreDefs } from "../scan/def_embed.js";
import { type Def } from "../scan/def_table.js";
import { find_anchor_candidates, _content_words } from "./anchor_rank.js";
import { type ProbedAnchor } from "./anchor_select.js";

const PASS = registerPass({ tag: "anchor-pick", tier: "strong", note: "direct anchor selection from candidate passages (no probe)" });

const _NON_ANCHOR = new Set(["interface", "type", "enum"]);   // data shapes, never a starting point
const EMBED_TOP = 20;   // rich (Def-carrying) embed candidates
const POOL_CAP = 30;    // bound the prompt

// The candidate's embed PASSAGE — declaration + enclosing + file path + doc. The path is the domain signal.
function passage(d: Def): string {
  const encl = d.enclosing ? ` in ${d.enclosing}` : "";
  const doc = d.doc ? ` :: ${d.doc}` : "";
  return `${d.signature || d.name}${encl} — ${d.file}${doc}`;
}

export async function pick_anchor(repo: string, intent: string, opts: { model?: string; claudeBin?: string | null } = {}):
    Promise<{ chosen: ProbedAnchor | null; chosenBy: "pick" | "none" }> {
  if (!available(opts.claudeBin)) return { chosen: null, chosenBy: "none" };

  const scored = await embedScoreDefs(repo, intent);   // [] when embeddings absent → caller falls back
  const defByKey = new Map<string, Def>(), defByName = new Map<string, Def>();
  for (const { def } of scored) {
    const k = `${def.name}|${def.file}`;
    if (!defByKey.has(k)) defByKey.set(k, def);
    if (!defByName.has(def.name)) defByName.set(def.name, def);
  }

  type Cand = { name: string; file: string; kind: string; def?: Def };
  const pool: Cand[] = [], have = new Set<string>();
  const add = (name: string, file: string, kind: string, def?: Def) => {
    const k = `${name}|${file}`;
    if (have.has(k) || _NON_ANCHOR.has(kind)) return;
    have.add(k); pool.push({ name, file, kind, def });
  };
  // embed top-K (Def-rich) — add each def AS ITSELF (a strongly-matching METHOD enters the pool as the
  // method, with its own signature+doc passage). Collapsing a method to its enclosing class used to bury the
  // signal: `sendParaplanningRequestEmail` became `FileNoteService` (doc-less class passage) so the LLM
  // couldn't see the "paraplanning" words and picked a worse candidate it COULD read. Anchoring on the
  // method is precisely what works when you pass --symbol explicitly, and the grow follows it the same way.
  for (const { def } of scored.slice(0, EMBED_TOP)) add(def.name, def.file, def.kind, def);
  // lexical floor (no LLM expand) — enrich each with its Def so it shows a full passage too
  for (const c of find_anchor_candidates(repo, [..._content_words(intent)]))
    add(c.name, c.file, c.kind, defByKey.get(`${c.name}|${c.file}`) ?? defByName.get(c.name));

  const cand = pool.slice(0, POOL_CAP);
  if (!cand.length) return { chosen: null, chosenBy: "none" };

  // DIAGNOSTIC (SEAM_ANCHOR_DEBUG=1): dump the embed ranking + the candidate pool so we can see whether the
  // RIGHT anchor was even recalled (and at what rank), and what PASSAGE the LLM judged it on. Reveals the
  // method→enclosing-class collapse (a method's intent words vanish behind its class's doc).
  if (process.env.SEAM_ANCHOR_DEBUG) {
    const rankByKey = new Map(scored.map(({ def }, i) => [`${def.name}|${def.file}`, i]));
    const e = process.stderr;
    e.write(`\n[anchor-debug] intent: "${intent}"\n[anchor-debug] embed-ranked defs (top 30 of ${scored.length}):\n`);
    scored.slice(0, 30).forEach(({ def, score }, i) => e.write(`   #${i} ${score.toFixed(3)} ${def.name}${def.enclosing ? " in " + def.enclosing : ""} (${def.file})\n`));
    e.write(`[anchor-debug] candidate pool (${cand.length}):\n`);
    cand.forEach((c, i) => e.write(`   c${i} ${c.name} (${c.file})${c.def ? ` [embed#${rankByKey.get(`${c.def.name}|${c.def.file}`) ?? "?"}] passage: ${passage(c.def).slice(0, 160)}` : " [lexical]"}\n`));
  }

  const lines = [
    `A developer asks: "${intent}". Pick the SINGLE best STARTING POINT to answer it — the symbol whose`,
    "code is the mechanism/entry the question is about (where you'd start reading the flow), NOT a leaf",
    "helper, a test, or a class that merely participates. Each candidate shows its declaration, enclosing",
    "class, file path, and doc-comment — judge by what it IS and DOES, matched to the question (the name",
    "alone can mislead; the path is a strong hint).", "",
  ];
  cand.forEach((c, i) => lines.push(`  c${i}: ${c.def ? passage(c.def) : `${c.name} — ${c.file}`}`));
  lines.push("", 'Output ONLY a JSON array, one object per candidate: [{"id":"c<n>","best":true|false}] with `best` true for exactly ONE.');

  let out: Map<string, any>;
  try { out = run_pass(lines.join("\n"), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag }); }
  catch (e) { if (e instanceof LLMError) return { chosen: null, chosenBy: "none" }; throw e; }

  for (let i = 0; i < cand.length; i++) {
    const o = out.get(`c${i}`);
    if (o && typeof o === "object" && [true, "true", "True"].includes(o.best)) {
      const c = cand[i];
      if (process.env.SEAM_ANCHOR_DEBUG) process.stderr.write(`[anchor-debug] LLM picked c${i}: ${c.name} (${c.file})\n`);
      return {
        chosen: { id: `c${i}`, name: c.name, file: c.file, kind: c.kind, score: 0, terms: ["~pick"],
                  metrics: null, structScore: 0, signature: c.def?.signature, doc: c.def?.doc },
        chosenBy: "pick",
      };
    }
  }
  return { chosen: null, chosenBy: "none" };
}
