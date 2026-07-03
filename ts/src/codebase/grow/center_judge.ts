// The center-first SEMANTIC judge (the one LLM in the loop, pure-CLI only — an agent passes --center and this
// never runs). Given the lexical RECALL net, the model picks which candidates are the concern's core mechanism.
// Isolated here so center_repo.ts stays LLM-free (injection); auto→llm degrades to the lexical floor when there
// is no backend (returns null → the caller keeps the recall order).
import { run_pass_async, registerPass, available } from "../../core/llm.js";
import type { CenterCandidate, CenterJudge } from "./center_repo.js";

const PASS = registerPass({ tag: "center-pick", tier: "strong", note: "pick the concern's core mechanism(s) from the recall net — semantic" });

export function centerJudgeLlm(model?: string, claudeBin?: string | null): CenterJudge {
  return async (intent: string, cands: CenterCandidate[]): Promise<string[] | null> => {
    if (!available(claudeBin)) return null;   // offline → the deterministic lexical floor
    const lines = [
      `A developer asks: "${intent}".`,
      ``,
      `Below are candidate definitions from the codebase (id: symbol — file):`,
      ...cands.map((c, i) => `  c${i}: ${c.symbol} — ${c.file}`),
      ``,
      `Which are the CORE MECHANISM the question is about — the service/function that PERFORMS the behaviour`,
      `(e.g. "how are bookings created" → the createBooking service, not a UI form or a payload type)? EXCLUDE`,
      `UI components, tests, DTOs/inputs/outputs/models, config, and thin wrappers/helpers.`,
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
