// The center-first SEMANTIC judge (the one LLM in the loop, pure-CLI only — an agent passes --center and this
// never runs). Given the lexical RECALL net, the model picks which candidates are the concern's core mechanism.
// Isolated here so center_repo.ts stays LLM-free (injection); auto→llm degrades to the lexical floor when there
// is no backend (returns null → the caller keeps the recall order).
import { run_pass_async, registerPass, available } from "../../core/llm.js";
import type { CenterCandidate, CenterJudge, DirJudge } from "./center_repo.js";

const DIR_PASS = registerPass({ tag: "center-dir-pick", tier: "strong", note: "pick the domain directory the concern is implemented in — semantic" });
const PASS = registerPass({ tag: "center-pick", tier: "strong", note: "pick the concern's core mechanism(s) from the recall net — semantic" });

// STAGE 1 — navigate the codebase the way a dev would: pick the DOMAIN DIRECTORY(ies) the concern lives in, from
// the source tree. This is what keyword-recall over def names can't do — the LLM knows "bookings" is the domain
// and "managed" the action, and points at `…/bookings/`. Offline (no backend) → null → the caller's lexical floor.
export function centerDirJudgeLlm(model?: string, claudeBin?: string | null): DirJudge {
  return async (intent: string, dirs: { dir: string; sample: string[] }[]): Promise<string[] | null> => {
    if (!available(claudeBin)) return null;
    const lines = [
      `A developer asks: "${intent}".`,
      ``,
      `Below are the source directories in this codebase (id: dir — a few example files in it):`,
      ...dirs.map((d, i) => `  d${i}: ${d.dir} — ${d.sample.join(", ")}`),
      ``,
      `Which 1-3 directories most likely IMPLEMENT the behaviour the question is about (the domain package(s) for`,
      `it — e.g. "how are bookings created" → a .../bookings/ package)? Pick where the MECHANISM lives, not tests,`,
      `generic utils, config, or unrelated domains. Output ONLY a JSON array of the chosen ids: [{"id":"d5"}].`,
    ];
    let out: Map<string, unknown>;
    try { out = await run_pass_async(lines.join("\n"), { model, claudeBin, tag: DIR_PASS.tag }); } catch { return null; }
    const picked: string[] = [];
    for (const v of out.values()) { const m = /^d(\d+)$/.exec(String((v as { id?: unknown })?.id ?? "").trim()); if (m && dirs[+m[1]]) picked.push(dirs[+m[1]].dir); }
    return picked.length ? picked : null;
  };
}

export function centerJudgeLlm(model?: string, claudeBin?: string | null): CenterJudge {
  return async (intent: string, cands: CenterCandidate[]): Promise<string[] | null> => {
    if (!available(claudeBin)) return null;   // offline → the deterministic lexical floor
    const lines = [
      `A developer asks: "${intent}".`,
      ``,
      `Below are candidate definitions from the codebase (id: symbol — file — callers=fan-in):`,
      ...cands.map((c, i) => `  c${i}: ${c.symbol} — ${c.file} — callers=${c.fanIn}`),
      ``,
      `Which are the CORE MECHANISM the question is about — the service/bean/function that PERFORMS the behaviour`,
      `(e.g. "how are bookings created" → the createBooking service, not a UI form or a payload type)? EXCLUDE`,
      `UI components, tests, DTOs/inputs/outputs/models, config, and thin wrappers/helpers. Prefer a def that is`,
      `actually USED (callers > 0) or that clearly orchestrates the behaviour — a zero-caller CONSTANTS/DATA class`,
      `is a dead-end, never the mechanism.`,
      `Output ONLY a JSON array of the 1-4 chosen: [{"id":"c3"},{"id":"c12"}].`,
    ];
    let out: Map<string, unknown>;
    try { out = await run_pass_async(lines.join("\n"), { model, claudeBin, tag: PASS.tag }); } catch { return null; }
    const picked: string[] = [];
    for (const v of out.values()) {
      const m = /^c(\d+)$/.exec(String((v as { id?: unknown })?.id ?? "").trim());
      if (m && cands[+m[1]]) picked.push(`${cands[+m[1]].symbol} ${cands[+m[1]].file}`);
    }
    return picked.length ? picked : null;
  };
}
