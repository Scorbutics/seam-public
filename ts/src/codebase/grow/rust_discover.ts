// RUST-MIDDLE FLYWHEEL DRIVER (Phase 6) — runs the Rust discovery state machine, serving its 1–2 LLM passes via
// run_pass_async (claude/host-bus). ALL flywheel logic (find blind reps, cluster, prompt, parse/validate, detect,
// dedup, persist) is in Rust (seam-couple/learn/discover.rs); this driver is only the LLM transport + the loop.
// Learn-once → the persisted .seam/key-adapters.json is replayed byte-identically by the Rust grow forever after.

import { loadAddon } from "./rust_core.js";
import { run_pass_async } from "../../core/llm.js";
// The pass SPEC, not a re-spelled tag string. This import is also the REGISTRATION (registerPass runs on module
// load), and the registry is what routes `discover-key-matchers` to its declared `strong` tier. Naming the tag
// literally here left the registry empty on the Rust path → the pass ran on the cheap base model.
import { KEY_MATCHER_PASS } from "../../codebase/coupling/key_matcher.js";

// `scopeFiles` = the repo-relative files the flow reaches (a floor pre-grow's footprint). Mirrors llmKeyIndex's
// `opts.scopeFiles`: discovery considers ONLY those files. Omit for the unscoped whole-repo warm-adapters pass.
export interface DiscoverOpts { model?: string; claudeBin?: string | null; keyBudget?: number; scopeFiles?: string[] }

// Serve one discovery pass → the JSON array of the model's parsed objects (run_pass_async returns a Map keyed by
// id; Rust parse() validates the values, exactly as TS _parse iterates out.values()).
async function serve(prompt: string, opts: DiscoverOpts): Promise<string> {
  try {
    const out = await run_pass_async(prompt, { model: opts.model, claudeBin: opts.claudeBin, tag: KEY_MATCHER_PASS.tag });
    return JSON.stringify([...out.values()]);
  } catch (e) {
    // DEGRADE like TS learnKeyMatchers' `catch (LLMError) → []`: a failed/malformed LLM pass yields no new rules,
    // and the grow proceeds by replaying the matchers already in .seam. Never abort the grow on a flaky reply.
    process.stderr.write(`[rust-discover] LLM pass yielded no rules (${String((e as any)?.message ?? e).slice(0, 80)}) — replaying existing matchers\n`);
    return "[]";
  }
}

// Run the flywheel: find floor-blind reps → learn matcher rules (≤2 LLM passes) → persist. Returns #rules learned
// (0 = nothing to learn / replayed). No-op if the LLM backend is unavailable.
export async function rustDiscover(repo: string, opts: DiscoverOpts = {}): Promise<number> {
  const addon = loadAddon();
  const keyBudget = opts.keyBudget ?? 60;
  // FOOTPRINT-SCOPED (the TS `grow_footprint_scoped` contract): consider only the files the flow reaches, never
  // the whole repo. Unscoped, a 4-file flow in a 10k-file repo learned from — and LLM'd over — every blind file.
  const blind: string = addon.findBlindReps(repo, keyBudget, opts.scopeFiles);  // JSON "[[file,text],…]" — the detect corpus, threaded through
  const start = JSON.parse(addon.learnStart(repo, blind, keyBudget));
  if (start.kind === "replay") return start.matchers.length;   // already learned → the grow replays it
  if (start.kind === "nothing") return 0;                       // no blind files / no budget
  // start.kind === "prompt": serve the synth, ingest, one conditional retry, finalize.
  let budget = keyBudget;
  const a1 = await serve(start.prompt, opts); budget -= 1;
  const ing = JSON.parse(addon.learnIngest(blind, JSON.stringify(start.snippets), a1));
  if (ing.kind === "done") return JSON.parse(addon.learnCommit(repo, start.sig, JSON.stringify(ing.matchers))).length;
  // retry (the prompt echoes the dead tokens); skip serving if the budget is spent (→ "[]", matching TS synth's gate).
  const a2 = budget > 0 ? await serve(ing.prompt, opts) : "[]";
  return JSON.parse(addon.learnFinalize(repo, start.sig, blind, JSON.stringify(ing.accepted), a2)).length;
}
