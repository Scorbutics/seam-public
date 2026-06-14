#!/usr/bin/env bun
// Human-readable renderer for a GOLD or a classified RUN — raw JSON is hard to validate by eye.
// Joins the role/seam/wiring data with each hunk's file:line (from --emit-hunks) and prints a flat,
// scannable table: hunk → file:line → role → which seam it wires → why.
//
//   bun ts/eval/show.ts <case>                 # render ts/eval/gold/<case>.json
//   bun ts/eval/show.ts <case> --run <label>   # render ts/eval/_runs/<label>/<case>/run_1.json
//   bun ts/eval/show.ts all                    # render every gold
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const CASES = join(__dir, "..", "test", "cases");
const GOLD = join(__dir, "gold");
const RUNS = join(__dir, "_runs");
const CLI = join(__dir, "..", "src", "cli", "decompose.ts");
const BUN = process.env.HOME ? join(process.env.HOME, ".bun", "bin", "bun") : "bun";

const GLYPH: Record<string, string> = { core: "◆ CORE", link: "→ link", environment: "∙ env ", test: "✓ test", noise: "· noise" };

function locOf(name: string): Map<string, string> {
  const tmp = `/tmp/_show_${process.pid}.json`;
  execSync(`${BUN} ${CLI} --file ${join(CASES, `${name}.patch`)} --emit-hunks ${tmp}`, { stdio: "ignore" });
  const sk = JSON.parse(readFileSync(tmp, "utf-8")).hunks;
  return new Map(sk.map((h: any) => [h.id, `${h.file.split("/").slice(-1)[0]}:${h.start}-${h.end}`]));
}

function render(name: string, entries: any[], kind: "gold" | "run"): void {
  const loc = locOf(name);
  // seam id -> label (cores carry it)
  const seamLabel = new Map<string, string>();
  for (const h of entries) if (h.role === "core" && h.seam) seamLabel.set(h.seam, h.seam_label || h.seam);
  const seamOf = (id: string) => seamLabel.get(id) ? `${id}` : id;       // keep id; label shown in header
  const clusters = [...new Set(entries.map((h) => h.group || h.intent || "g1"))];
  console.log("\n" + "═".repeat(100));
  console.log(`▣ ${name}   (${kind})`);
  const intent = entries.find((h) => h.intent)?.intent;
  if (intent) console.log(`  intent: "${intent}"`);
  console.log(`  seams:  ${[...seamLabel].map(([id, l]) => `${id} = "${l}"`).join("   |   ") || "(none)"}`);
  console.log("─".repeat(100));
  for (const h of entries) {
    if (h.role === "noise") continue;
    let wires: string;
    if (h.role === "core") wires = `[anchors ${h.seam || "?"}]`;
    else {
      const ws = (h.wires ?? []).map(seamOf);
      const sug = new Set(h.suggested_wires ?? h.suggestedWires ?? []);
      const shown = ws.length ? ws.map((w: string) => (sug.has(w) ? `~${w}` : w)).join(",") : "(ambient)";
      wires = `→ ${shown}`;
    }
    const why = h.rationale || "";
    console.log(`  ${String(h.id).padEnd(3)} ${(GLYPH[h.role] ?? h.role).padEnd(7)} ${String(loc.get(h.id) ?? "?").padEnd(30)} ${wires.padEnd(16)} ${why}`);
  }
  if (kind === "run") console.log(`  (~ before a seam = a SUGGESTED / low-confidence wire)`);
}

const arg = process.argv[2];
const runFlag = process.argv.indexOf("--run");
const runLabel = runFlag >= 0 ? process.argv[runFlag + 1] : null;
if (!arg) { console.error("usage: bun ts/eval/show.ts <case|all> [--run <label>]"); process.exit(1); }

const names = arg === "all" ? readdirSync(GOLD).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : [arg];
for (const name of names) {
  if (runLabel) {
    const p = join(RUNS, runLabel, name, "run_1.json");
    if (!existsSync(p)) { console.error(`no run at ${p}`); continue; }
    render(name, JSON.parse(readFileSync(p, "utf-8")), "run");
  } else {
    const p = join(GOLD, `${name}.json`);
    if (!existsSync(p)) { console.error(`no gold at ${p}`); continue; }
    render(name, JSON.parse(readFileSync(p, "utf-8")), "gold");
  }
}
console.log();
