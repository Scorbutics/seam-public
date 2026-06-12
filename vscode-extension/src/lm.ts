// Service layer over VS Code's Language Model API (`vscode.lm`) — the "borrow the editor's model"
// backend. Seam's engine makes its OWN LLM calls via the host-bus (--emit-prompts/--inject-llm); this
// module serves those passes through whatever chat model the user already has (GitHub Copilot), so no
// `claude`/`copilot` CLI and no API key are needed. Kept deliberately thin and isolated (per
// CLAUDE.md: an intermediate layer over a replaceable external dependency) so the driver in
// extension.ts never touches the raw `vscode.lm` surface.
import * as vscode from "vscode";

export interface PickedModel {
  model: vscode.LanguageModelChat;
  name: string;
  maxInputTokens: number;
}

// Choose the best available chat model: prefer Copilot, fall back to any registered provider, and
// among them pick the LARGEST input window (gpt-4.1 / Claude ≈ 128K beat gpt-4o's 64K) — that is the
// primary mitigation for big PRs (see the token gate). Returns undefined when the user has no model.
export async function selectBestModel(): Promise<PickedModel | undefined> {
  let models: vscode.LanguageModelChat[] = [];
  try { models = await vscode.lm.selectChatModels({ vendor: "copilot" }); } catch { /* none */ }
  if (!models.length) { try { models = await vscode.lm.selectChatModels(); } catch { /* none */ } }
  if (!models.length) return undefined;
  const best = models.slice().sort((a, b) => (b.maxInputTokens ?? 0) - (a.maxInputTokens ?? 0))[0];
  return { model: best, name: best.name || best.id, maxInputTokens: best.maxInputTokens ?? 0 };
}

// Tokens this prompt would consume against the chosen model (the model's own tokenizer — authoritative,
// not an estimate). Used to pre-flight each pass against maxInputTokens before sending.
export function countTokens(picked: PickedModel, text: string,
                            token?: vscode.CancellationToken): Thenable<number> {
  return picked.model.countTokens(text, token);
}

// Run one pass: send the prompt as a single user turn, accumulate the streamed reply. The engine's
// JSON-array extractor parses the raw text exactly as it would a `claude -p` reply. Translates the
// vscode.lm failure modes (no consent, blocked, quota) into messages a reviewer can act on.
export async function completeText(picked: PickedModel, prompt: string,
                                   token: vscode.CancellationToken): Promise<string> {
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  let resp: vscode.LanguageModelChatResponse;
  try {
    resp = await picked.model.sendRequest(messages, {}, token);
  } catch (e) {
    throw new Error(friendlyLmError(e));
  }
  let text = "";
  try {
    for await (const chunk of resp.text) text += chunk;
  } catch (e) {
    throw new Error(friendlyLmError(e));
  }
  if (!text.trim()) throw new Error("the language model returned an empty reply");
  return text;
}

function friendlyLmError(e: unknown): string {
  if (e instanceof vscode.LanguageModelError) {
    switch (e.code) {
      case "NoPermissions":
        return "access to the language model was denied — allow Seam to use the model when VS Code asks, "
          + "then re-run.";
      case "Blocked":
        return "the language model blocked this request (content filter or quota). Try a smaller range, "
          + "or switch seam.llmBackend to \"cli\".";
      default:
        return `language model error (${e.code || "unknown"}): ${e.message}`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
