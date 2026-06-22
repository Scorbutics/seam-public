// SELF-VALIDATING KEY-ADAPTER SYNTHESIS — the flywheel that lets Seam LEARN a new framework's shared-key
// shape on the fly and then run it DETERMINISTICALLY. The loop (per the teacher-3 design, hardened with a
// re-execution gate the carrier teacher lacks):
//   1. a floor-blind file has a data edge no adapter keys
//   2. the LLM synthesizes a CONSTRAINED matcher IR (key_ir.ts) — the rule's SHAPE, never a regex
//   3. RE-EXECUTE the matcher deterministically over the files it was derived from
//   4. accept ONLY if it detects ≥1 key (it actually matches) — a hallucinated rule matches nothing
//   5. one self-correction retry on a detection miss (feed the dead tokens back), else drop
//   6. persist the survivors to `.seam/` → applied deterministically forever (LLM once → det after)
// GROUNDING (the same literal must co-occur at a producer AND a consumer) is enforced downstream by the
// shared-key index, exactly as for the floor — so a detected-but-uncorroborated key still can't fabricate
// an edge. Gated on `--data-coupling llm` + budget; the LLM seam is the shared run_pass (host-bus/claude/
// copilot), no API key.
import { run_pass, registerPass, ClassifierError as LLMError } from "../../core/llm.js";
import { emit } from "../../core/progress.js";
import { walkFiles } from "../../core/resolve/walk.js";
import { SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { scan_file_keys, scannableForKeys } from "./adapters/index.js";
import { COUPLING } from "./config.js";
import { EngineCtx } from "../engine_ctx.js";
import type { GroundingIndex } from "./types.js";
import { type KeyMatcher, validateMatcher, runMatcher } from "./key_ir.js";
import { persistMatchers } from "./key_matcher_cache.js";

const PASS = registerPass({ tag: "discover-key-matchers", tier: "strong", note: "reusable shared-key adapter-rule synthesis (semantic, learn-once → .seam)" });

const SNIPPET_CAP = COUPLING.snippetCap;
const PER_FILE = COUPLING.perFile;

export interface MatcherOpts { llm?: boolean; model?: string; claudeBin?: string | null }

function _prompt(files: { file: string; snippet: string }[], deadTokens: string[]): string {
  const blocks = files.map((f) => `=== FILE: ${f.file} ===\n${f.snippet}`).join("\n\n");
  const retry = deadTokens.length
    ? `\nA PREVIOUS attempt proposed rules whose token matched NOTHING literally in these files: `
      + `${deadTokens.join(", ")}. Either correct the token/argIndex to a call that LITERALLY appears above, or omit it.\n`
    : "";
  return `You are LEARNING reusable DETECTION RULES for DATA-FLOW couplings carried by a SHARED KEY — an
identifier two files share with NO import/call between them (a DB table, queue/topic, event name, cache
key, route). Each RULE describes a CALL with a string-literal key argument: emit('evt'), publish('topic'),
cache.get('k'), from('table'). You describe the rule's SHAPE, not the value.
${retry}
${blocks}

For every rule with CONCRETE evidence above, output one object. Do NOT invent rules — only calls literally
present. A wrong rule is worse than silence.
  via       — "call"
  token     — the callee identifier EXACTLY as written (e.g. "$emit", "publish", "from")
  argIndex  — 0-based index of the string argument that IS the key
  kind      — db-table | queue | event | route | cache | key
  role      — "produces" if the call WRITES/EMITS/PUBLISHES the key, "consumes" if it READS/SUBSCRIBES/HANDLES it

Return a JSON array (empty if none):
[{"id":"r1","via":"call","token":"$emit","argIndex":0,"kind":"event","role":"produces","name":"vue-emit","description":"emits a component event"}]
`;
}

function _parse(out: Map<string, any>): KeyMatcher[] {
  const seen = new Set<string>();
  const matchers: KeyMatcher[] = [];
  for (const obj of out.values()) {
    const m = validateMatcher(obj);
    if (!m) continue;
    const id = `${m.token} ${m.argIndex} ${m.kind} ${m.role}`;
    if (seen.has(id)) continue;
    seen.add(id);
    matchers.push(m);
  }
  return matchers;
}

// A matcher DETECTS if it re-executes to ≥1 key over the candidate files (step 3-4: it actually matches).
const _detects = (m: KeyMatcher, files: { file: string; text: string }[]): boolean =>
  files.some((f) => runMatcher(m, f.text).length > 0);

// LEARN reusable matchers from floor-blind files: synthesize → validate shape → re-execute → keep only those
// that detect, with one self-correction retry on the misses → persist + return. No-op without opts.llm/budget.
export async function learnKeyMatchers(
  repo: string, blindFiles: { file: string; text: string }[], opts: MatcherOpts, ctx: EngineCtx,
): Promise<KeyMatcher[]> {
  if (!opts.llm || !blindFiles.length || ctx.keyBudget <= 0) return [];
  // bound the snippet payload (the LLM derives tokens from the visible code) — first files up to the cap
  const snippets: { file: string; snippet: string }[] = [];
  let size = 0;
  for (const f of blindFiles) {
    const len = Math.min(f.text.length, PER_FILE);
    if (size + len > SNIPPET_CAP && snippets.length) break;
    snippets.push({ file: f.file, snippet: f.text.slice(0, PER_FILE) });
    size += len;
  }

  const synth = (deadTokens: string[]): KeyMatcher[] => {
    if (ctx.keyBudget <= 0) return [];
    ctx.keyBudget -= 1;
    try { return _parse(run_pass(_prompt(snippets, deadTokens), { model: opts.model, claudeBin: opts.claudeBin, tag: PASS.tag })); }
    catch (e) { if (!(e instanceof LLMError)) throw e; return []; }
  };

  emit(`Learning shared-key adapter rule(s) for ${snippets.length} floor-blind file(s) via LLM…`);
  const candidates = synth([]);
  const accepted: KeyMatcher[] = [], failed: KeyMatcher[] = [];
  for (const m of candidates) (_detects(m, blindFiles) ? accepted : failed).push(m);

  // step 5 — ONE self-correction round on the detection misses (don't waste a call if there were none)
  if (failed.length) {
    for (const m of synth(failed.map((f) => f.token)))
      if (!accepted.some((a) => a.token === m.token && a.kind === m.kind && a.role === m.role && a.argIndex === m.argIndex) && _detects(m, blindFiles))
        accepted.push(m);
  }

  persistMatchers(repo, accepted);
  return accepted;
}

// APPLY matchers deterministically across the repo → a grounding index of their hits MINUS the keys the
// floor already covers (reconciliation — a learned rule that duplicates an adapter is not double-counted).
// No LLM. Empty matchers → empty index (and no walk), so a cold det run with no `.seam/` pays nothing.
export function applyMatchers(repo: string, matchers: KeyMatcher[], skipDirs: Set<string> = SKIP_DIRS): GroundingIndex {
  const idx: GroundingIndex = new Map();
  if (!matchers.length) return idx;
  for (const { rel, text } of walkFiles(repo, skipDirs, scannableForKeys)) {
    const floor = new Set(scan_file_keys(rel, text).map((h) => `${h.kind} ${h.value}`));
    for (const m of matchers) for (const h of runMatcher(m, text)) {
      const id = `${h.kind} ${h.value}`;
      if (floor.has(id)) continue;                                   // floor already covers it → reconcile away
      if (!idx.has(id)) idx.set(id, { producers: [], consumers: [] });
      (h.produces ? idx.get(id)!.producers : idx.get(id)!.consumers).push({ file: rel, line: h.line });
    }
  }
  return idx;
}
