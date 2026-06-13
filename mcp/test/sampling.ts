// Proves the interactive host-bus ↔ MCP sampling bridge end-to-end, WITHOUT a real LLM. The mock
// client declares the sampling capability and answers each createMessage by reading the pass's prompt
// and returning a valid reply — for the cluster pass it tags each group with a DISTINCTIVE "sampled-…"
// label so we can assert the client's model actually drove the engine output (not a silent det
// fallback). The engine runs with --llm-bridge and is served each pass on demand over the bridge.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, "..", "src", "server.ts")],
});
const client = new Client({ name: "seam-mcp-sampling", version: "0.0.0" }, { capabilities: { sampling: {} } });

let sampleCalls = 0;
client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
  sampleCalls++;
  const prompt = req.params.messages.map((m: any) => (m.content?.text ?? "")).join("\n");
  const groups = [...prompt.matchAll(/GROUP (\w+):/g)].map((m) => m[1]);
  const hunks = [...prompt.matchAll(/HUNK (\w+)/g)].map((m) => m[1]);
  let arr: any[] = [];
  if (groups.length) arr = groups.map((id) => ({ id, intent: `sampled-${id}` }));       // label-clusters
  else if (hunks.length) arr = hunks.map((id) => ({ id, group: "g1", intent: "sampled" })); // cluster grouping
  return { model: "mock", role: "assistant", content: { type: "text", text: JSON.stringify(arr) } };
});

await client.connect(transport);

const diff = readFileSync(join(REPO, "sample.patch"), "utf-8");
const res: any = await client.callTool({ name: "decompose_diff", arguments: { diff, engine: "hybrid" } });
console.log("sampling calls:", sampleCalls);
console.log("isError:", res.isError ?? false);
console.log("--- summary ---");
console.log(res.content[0].text);

if (res.isError) throw new Error("hybrid via sampling errored: " + res.content[0].text);
if (sampleCalls < 1) throw new Error("the server never sampled the client's model");
const json = JSON.parse(res.content[1].text.replace(/^```json\n/, "").replace(/\n```$/, ""));
if (json.schemaVersion !== 1) throw new Error("schemaVersion missing/wrong");
// Proof the client's reply DROVE the output: the cluster intents are our distinctive sampled labels.
const intents = (json.clusters ?? []).map((c: any) => c.intent);
console.log("cluster intents:", JSON.stringify(intents));
if (!intents.some((i: string) => /^sampled-/.test(i)))
  throw new Error("client model did NOT drive clustering — labels are not the sampled ones (silent det fallback?)");

await client.close();
console.log("\nOK ✓  (the client's sampled labels drove the engine's cluster intents)");
