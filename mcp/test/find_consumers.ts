// End-to-end check for the find_consumers tool: spawn the server over stdio, list tools, call
// find_consumers (det, offline) on the class-repo fixture, and assert the resolved-set contract.
// Run: `bun test/find_consumers.ts`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const fixture = join(REPO, "ts", "test", "fixtures", "class-repo");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, "..", "src", "server.ts")],
});
const client = new Client({ name: "find-consumers-smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
if (!tools.tools.some((t) => t.name === "find_consumers")) throw new Error("find_consumers not registered");

const res: any = await client.callTool({ name: "find_consumers", arguments: { repo: fixture, anchorFile: "src/payment/service.ts", symbol: "charge" } });
console.log("isError:", res.isError ?? false);
console.log("--- summary ---\n" + res.content[0].text);

const json = JSON.parse(res.content[1].text.replace(/^```json\n/, "").replace(/\n```$/, ""));
console.log("--- contract ---");
console.log("shape:", json.shape, "| schemaVersion:", json.schemaVersion, "| members:", json.members?.length);
if (json.shape !== "set") throw new Error("shape != set");
if (json.schemaVersion !== 1) throw new Error("schemaVersion missing");
const tiers = Object.fromEntries(json.members.map((m: any) => [m.symbol, m.provenance]));
if (JSON.stringify(tiers) !== JSON.stringify({ admin: "RESOLVED_FULL", checkout: "RESOLVED_FULL", make: "RESOLVED_PARTIAL" }))
  throw new Error("unexpected member tiers: " + JSON.stringify(tiers));

await client.close();
console.log("\nOK ✓");
