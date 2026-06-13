// Proves the AUTO-GROW loop (grow_intent) runs over the interactive bridge: the engine's
// orchestration move — the in-the-loop LLM call whose prompt depends on the current footprint — is
// served by the CLIENT's model via sampling, not a nested CLI. The mock answers the orchestrate pass
// with done=true (stop after the seed, deterministic + fast) and returns "[]" for the decomposition
// passes (which degrade gracefully). We assert the client was asked the GROW prompt at least once.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const TS_REPO = join(REPO, "ts");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, "..", "src", "server.ts")],
});
const client = new Client({ name: "seam-mcp-autogrow", version: "0.0.0" }, { capabilities: { sampling: {} } });

let sampleCalls = 0;
let orchestrateSeen = false;
client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
  sampleCalls++;
  const prompt = req.params.messages.map((m: any) => (m.content?.text ?? "")).join("\n");
  let arr: any[] = [];
  if (/GROWING a code footprint/.test(prompt)) {            // the orchestration move
    orchestrateSeen = true;
    arr = [{ id: "step", node: "", direction: "up", done: true }];   // footprint covers it → stop at the seed
  }
  return { model: "mock", role: "assistant", content: { type: "text", text: JSON.stringify(arr) } };
});

await client.connect(transport);

const res: any = await client.callTool({
  name: "grow_intent",
  arguments: {
    repo: TS_REPO,
    anchorFile: "src/core/progress.ts",
    symbol: "emit",
    intent: "where are progress messages emitted from",
    maxSteps: 2,
    engine: "hybrid",
  },
});

console.log("sampling calls:", sampleCalls);
console.log("orchestrate prompt served by client:", orchestrateSeen);
console.log("isError:", res.isError ?? false);
console.log("--- summary ---");
console.log(res.content[0].text);

if (res.isError) throw new Error("grow_intent errored: " + res.content[0].text);
if (!orchestrateSeen) throw new Error("the auto-grow move was NOT served by the client's model (bridge not used?)");
if (sampleCalls < 1) throw new Error("the server never sampled the client's model");
const json = JSON.parse(res.content[1].text.replace(/^```json\n/, "").replace(/\n```$/, ""));
if (json.schemaVersion !== 1) throw new Error("schemaVersion missing/wrong");
if (json.autoGrown !== true) throw new Error("model is not flagged autoGrown — the auto path did not run");

await client.close();
console.log("\nOK ✓  (the client's model drove the auto-grow orchestration over the bridge)");
