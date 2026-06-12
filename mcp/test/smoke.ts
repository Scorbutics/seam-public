// End-to-end smoke test: spawn the server over stdio with a real MCP client, list tools, and call
// decompose_diff (engine=det, offline) on the repo's sample.patch. Run: `bun test/smoke.ts`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const transport = new StdioClientTransport({
  command: process.execPath,                       // bun
  args: [join(HERE, "..", "src", "server.ts")],
});
const client = new Client({ name: "seam-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const diff = readFileSync(join(REPO, "sample.patch"), "utf-8");
const res: any = await client.callTool({ name: "decompose_diff", arguments: { diff, engine: "det" } });
console.log("isError:", res.isError ?? false);
console.log("--- summary ---");
console.log(res.content[0].text);

const json = JSON.parse(res.content[1].text.replace(/^```json\n/, "").replace(/\n```$/, ""));
console.log("--- contract check ---");
console.log("schemaVersion:", json.schemaVersion, "| clusters:", json.clusters?.length);
if (json.schemaVersion !== 1) throw new Error("schemaVersion missing/wrong");
if (!Array.isArray(json.clusters)) throw new Error("clusters missing");

await client.close();
console.log("\nOK ✓");
