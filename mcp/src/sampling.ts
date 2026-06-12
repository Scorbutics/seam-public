// The elegant fit: Seam's pipeline makes its OWN LLM calls (cluster/role passes). Rather than spawn a
// nested `claude -p` (a second model, an API key, double cost), we borrow the CALLING client's model
// via MCP sampling — which maps exactly onto the engine's host-bus contract:
//
//   phase 1   seam … --emit-prompts P   → records each pass's prompt, runs/applies NOTHING
//   bridge    for each pass: sampling/createMessage(prompt) → the client's LLM answers
//   phase 2   seam … --inject-llm A --emit-seams S   → replays the answers, emits the model
//
// This is the same two-phase handshake the `seam-review` skill uses to serve passes from the live
// Claude session. See docs/DISTRIBUTION.md §3.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { EngineError, readJson, runEngine, writeText } from "./engine.js";

export function clientSupportsSampling(server: McpServer): boolean {
  return !!server.server.getClientCapabilities()?.sampling;
}

interface RecordedPass { tag: string; prompt: string; model: string; thinking: number | null; }

// One sampling round-trip: hand a pass's prompt to the client's model, return its raw text (the
// engine's JSON-array extractor parses it exactly as it would a `claude -p` reply).
async function sampleOnce(server: McpServer, prompt: string): Promise<string> {
  const res = await server.server.createMessage({
    messages: [{ role: "user", content: { type: "text", text: prompt } }],
    maxTokens: 8192,
  });
  const c = res.content;
  if (c && c.type === "text" && typeof c.text === "string") return c.text;
  throw new EngineError("sampling returned no text content");
}

// Run an LLM-backed decomposition by serving every pass from the client's model. `baseFlags` are the
// engine flags that select the input + engine (e.g. --file X --classifier hybrid) WITHOUT any
// --emit-prompts / --inject-llm / --emit-seams (this adds them).
export async function decomposeWithSampling(
  server: McpServer, baseFlags: string[], scratch: string,
): Promise<{ model: any; passes: number }> {
  if (!clientSupportsSampling(server))
    throw new EngineError(
      "this engine setting needs LLM passes, but the MCP client does not support sampling. "
      + "Use engine=\"det\" (fully offline), or call from a sampling-capable client.");

  const promptsPath = join(scratch, "prompts.json");
  runEngine([...baseFlags, "--emit-prompts", promptsPath]);
  const passes: RecordedPass[] = readJson(promptsPath).passes ?? [];

  const answers: Record<string, string> = {};
  for (const p of passes) answers[p.tag] = await sampleOnce(server, p.prompt);   // sequential: passes can depend on each other

  const answersPath = join(scratch, "answers.json");
  writeText(answersPath, JSON.stringify({ answers }));
  const outPath = join(scratch, "seams.json");
  runEngine([...baseFlags, "--inject-llm", answersPath, "--emit-seams", outPath]);
  return { model: readJson(outPath), passes: passes.length };
}
