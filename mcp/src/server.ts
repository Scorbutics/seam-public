// Seam MCP server — lets ANY LLM agent consult Seam about a diff or an intent footprint, over the
// same --emit-seams JSON contract the VS Code extension consumes. Thin by design: it locates the
// stateless engine (binary or source CLI) and shells out per call. No daemon, no engine state.
//
// Two reaches for the LLM passes:
//   • engine="det"  → fully offline, no model at all. The robust default; most agents want the
//                     STRUCTURE (seams/roles/wiring), not Seam's own prose.
//   • engine="hybrid"/"llm" → borrows the CALLING client's model via MCP sampling (see sampling.ts).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";
import { EngineError, readJson, runEngine, withScratch, writeText } from "./engine.js";
import { decomposeWithSampling } from "./sampling.js";

const ENGINE = z.enum(["det", "hybrid", "llm"]).default("det")
  .describe("det = offline, no LLM (default, recommended). hybrid/llm borrow YOUR model via MCP sampling.");

// A compact human-facing summary so a chat client shows something legible above the JSON.
function summarize(model: any): string {
  const clusters = model.clusters ?? [];
  const seams = clusters.reduce((n: number, c: any) => n + (c.seams?.length ?? 0), 0);
  const roleCounts: Record<string, number> = {};
  for (const c of clusters) for (const s of c.seams ?? []) for (const h of s.hunks ?? [])
    roleCounts[h.role] = (roleCounts[h.role] ?? 0) + 1;
  for (const h of [...(model.tests ?? []), ...(model.noise ?? [])]) roleCounts[h.role] = (roleCounts[h.role] ?? 0) + 1;
  const roles = Object.entries(roleCounts).map(([r, n]) => `${r}=${n}`).join("  ");
  const intents = clusters.map((c: any) => `• ${c.intent}`).join("\n");
  const head = `${clusters.length} cluster(s), ${seams} seam(s)   [${roles}]`;
  const extras = [
    model.mode ? `mode=${model.mode}` : "",
    model.anchor ? `anchor=${model.anchor}` : "",
    model.resolutionQuality ? `resolution=${model.resolutionQuality}` : "",
    model.usage ? `${model.usage.calls} LLM call(s)` : "",
  ].filter(Boolean).join("  ");
  return `${head}${extras ? `   (${extras})` : ""}\n${intents}`;
}

// Both content shapes: a JSON block for the agent to parse, a summary for a human to read.
function reply(model: any) {
  return { content: [
    { type: "text" as const, text: summarize(model) },
    { type: "text" as const, text: "```json\n" + JSON.stringify(model) + "\n```" },
  ] };
}

function errReply(e: unknown) {
  const msg = e instanceof EngineError ? e.message : `unexpected error: ${(e as Error).message}`;
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

async function decompose(server: McpServer, baseFlags: string[], engine: string) {
  return withScratch(async (scratch) => {
    if (engine === "det") {
      const out = join(scratch, "seams.json");
      runEngine([...baseFlags, "--classifier", "det", "--emit-seams", out]);
      return reply(readJson(out));
    }
    const { model } = await decomposeWithSampling(server, [...baseFlags, "--classifier", engine], scratch);
    return reply(model);
  });
}

const server = new McpServer(
  { name: "seam", version: "0.1.0" },
  { instructions:
      "Seam decomposes a code change (or a codebase footprint around an anchor) into review SEAMS — "
      + "units of one intent — labelling each hunk core/link/environment/test/noise with wiring. Use "
      + "`decompose_diff` to understand what a diff actually does and how to review it by intent; use "
      + "`intent_footprint` to map where a symbol/intent lives across a codebase. Default engine 'det' "
      + "is offline and instant; 'hybrid'/'llm' add product-intent labels using YOUR model via sampling." },
);

server.registerTool("decompose_diff", {
  title: "Decompose a diff into review seams",
  description:
    "Group a git diff into seams (one technical intent each), labelling every hunk by role "
    + "(core/link/environment/test/noise) with wiring and optional blast-radius. Pass `diff` (raw "
    + "unified-diff text) OR `repo`+`range` (a git revision range like 'HEAD~1' or 'main...HEAD'). "
    + "Returns the Seam JSON model (docs/SEAM_JSON_CONTRACT.md). Roles top out ~0.8 accuracy and "
    + "confidence<0.6 means 'maybe' — the tool structures, the human judges.",
  inputSchema: {
    diff: z.string().optional().describe("Raw unified-diff text. Provide this OR repo+range."),
    repo: z.string().optional().describe("Absolute path to the git repo (with `range`)."),
    range: z.string().optional().describe("Git revision range, e.g. 'HEAD~1', 'main...HEAD'."),
    engine: ENGINE,
    blastRadius: z.boolean().default(false).describe("Also find files OUTSIDE the diff that import changed symbols."),
  },
}, async ({ diff, repo, range, engine, blastRadius }) => {
  try {
    if (!diff && !(repo && range))
      return errReply(new EngineError("provide `diff` (raw diff text) or both `repo` and `range`."));
    return await withScratch(async (scratch) => {
      const base: string[] = [];
      if (diff) { const p = join(scratch, "change.patch"); writeText(p, diff); base.push("--file", p); }
      else base.push("--git", range!);
      if (repo) base.push("--repo", repo);   // required for --git; with `diff` it enables resolved wiring / blast-radius
      if (blastRadius) base.push("--blast-radius");
      return await decompose(server, base, engine);
    });
  } catch (e) { return errReply(e); }
});

server.registerTool("intent_footprint", {
  title: "Map an intent's footprint across a codebase",
  description:
    "Starting from an ANCHOR (a symbol, or a whole module file), trace its footprint across the "
    + "codebase and decompose it into seams — who consumes it, what it wires, where the intent lives. "
    + "Honest about gaps: statically-opaque edges are returned as SUGGESTED/blindspots, never asserted. "
    + "Returns the Seam JSON model with codebase-mode fields (resolutionQuality, unresolved, blindspots).",
  inputSchema: {
    repo: z.string().describe("Absolute path to the git repo."),
    anchorFile: z.string().describe("Path to the file holding the anchor symbol/module (relative to repo or absolute)."),
    symbol: z.string().optional().describe("The anchor symbol. Omit to analyze the whole module (all its exports)."),
    intent: z.string().optional().describe("A natural-language intent to focus the footprint on (hybrid/llm engines)."),
    depth: z.number().int().min(1).max(4).default(1).describe("How many consumer hops to follow."),
    engine: ENGINE,
  },
}, async ({ repo, anchorFile, symbol, intent, depth, engine }) => {
  try {
    const base = ["--scan", "--repo", repo, "--anchor-file", anchorFile, "--depth", String(depth)];
    if (symbol) base.push("--symbol", symbol);
    if (intent) base.push("--intent", intent);
    return await decompose(server, base, engine);
  } catch (e) { return errReply(e); }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("seam-mcp: ready on stdio\n");
}

main().catch((e) => { process.stderr.write(`seam-mcp: fatal: ${e?.stack ?? e}\n`); process.exit(1); });
