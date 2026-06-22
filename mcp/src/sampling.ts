// The elegant fit: Seam's pipeline makes its OWN LLM calls (cluster/role passes, and the auto-grow
// orchestration loop). Rather than spawn a nested `claude -p` (a second model, an API key, double
// cost), we borrow the CALLING client's model via MCP sampling — served on demand over the engine's
// INTERACTIVE host bus:
//
//   spawn   seam … --classifier hybrid --llm-bridge DIR --emit-seams S   (runs the whole pipeline)
//   bridge  the engine drops req-<n>.json per pass and BLOCKS; we sample the client's model and
//           write resp-<n>.json; the engine reads it and continues — including IN-LOOP moves where
//           the next prompt depends on this answer (auto-orchestration).
//
// This supersedes the older batch emit-prompts → answer-all → inject-llm handshake: an interactive
// round-trip is strictly more general (a non-iterative decomposition is just a series of independent
// serves), and it's the only thing that can drive the auto-grow loop. See docs/DISTRIBUTION.md §3.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EngineError, REPO_ROOT, engineInvocation } from "./engine.js";

export function clientSupportsSampling(server: McpServer): boolean {
  return !!server.server.getClientCapabilities()?.sampling;
}

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// One sampling round-trip: hand a pass's prompt to the client's model, return its raw text (the
// engine's JSON-array extractor parses it exactly as it would a `claude -p` reply). `model` is the tier
// the engine stamped for this pass (haiku for the cheap passes, sonnet for the semantic ones) — forwarded
// as a sampling HINT so a cooperating client serves cheap passes on a cheap model instead of its default
// (often the expensive session model); these are fact-primed, thinking-off passes that don't need a big
// model. It's a preference, not a mandate — the client may ignore it.
async function sampleOnce(server: McpServer, prompt: string, model?: string): Promise<string> {
  const res = await server.server.createMessage({
    messages: [{ role: "user", content: { type: "text", text: prompt } }],
    maxTokens: 8192,
    ...(model ? { modelPreferences: { hints: [{ name: model }] } } : {}),
  });
  const c = res.content;
  if (c && c.type === "text" && typeof c.text === "string") return c.text;
  throw new EngineError("sampling returned no text content");
}

// Run the engine to completion while serving its every LLM pass from the client's model over the
// interactive bridge. `flags` are the full engine flags INCLUDING the --classifier and the --emit-*
// output target (this adds --llm-bridge). The engine writes its artifacts to those --emit-* files;
// the caller reads them after this resolves.
export async function runEngineWithBridge(server: McpServer, flags: string[], scratch: string): Promise<void> {
  if (!clientSupportsSampling(server))
    throw new EngineError(
      "this engine setting needs LLM passes, but the MCP client does not support sampling. "
      + "Use engine=\"det\" (fully offline), or call from a sampling-capable client.");

  const channel = join(scratch, "bridge");
  mkdirSync(channel, { recursive: true });
  const { cmd, pre, env } = engineInvocation();
  const proc = spawn(cmd, [...pre, ...flags, "--llm-bridge", channel], { cwd: REPO_ROOT, env: { ...process.env, ...env } });

  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  proc.stdout.on("data", () => { /* drain so the pipe never blocks the child */ });

  // Pump: answer each request the engine drops until the process exits. Requests are published
  // atomically (rename), so a listed req-*.json is always complete; the engine serves passes one at a
  // time (it blocks on each), so handling them sequentially here matches its cadence exactly.
  const handled = new Set<string>();
  let running = true;
  const pump = (async () => {
    while (running) {
      let names: string[] = [];
      try { names = readdirSync(channel).filter((f) => f.startsWith("req-") && f.endsWith(".json")); } catch { /* dir may lag */ }
      for (const name of names) {
        if (handled.has(name)) continue;
        handled.add(name);
        let req: any;
        try { req = JSON.parse(readFileSync(join(channel, name), "utf-8")); } catch { handled.delete(name); continue; }
        let text = "[]";
        try { text = await sampleOnce(server, req.prompt, req.model); }
        catch (e) { stderr += `\n[bridge] sampling failed for pass ${req.seq} (${req.tag}): ${(e as Error).message}`; }
        const tmp = join(channel, `resp-${req.seq}.tmp`);
        writeFileSync(tmp, JSON.stringify({ text }));
        renameSync(tmp, join(channel, `resp-${req.seq}.json`));   // atomic — the engine never reads a partial answer
      }
      await delay(40);
    }
  })();

  const code: number = await new Promise((res) => proc.on("close", (c) => res(c ?? 0)));
  running = false;
  await pump;
  if (code !== 0)
    throw new EngineError(`Seam engine failed (exit ${code}): ${(stderr || "").trim().slice(0, 600)}`);
}
