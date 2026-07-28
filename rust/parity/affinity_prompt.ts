// DIFFERENTIAL: Rust `seam_grow::affinity::build_affinity_prompt` vs the TypeScript oracle.
//
// The affinity prompt is a repo-wide regex scan (which files reference the footprint's subjects), a
// co-occurrence ranking, a cap, and a per-file gist. Every one of those decides WHICH candidates the model
// is shown, so a drift here changes the answer without changing anything visible — the model just judges a
// different set. Compared byte-for-byte.
//
// The prompt is CAPTURED THROUGH THE HOST BUS rather than from an extracted helper: the TypeScript builds it
// inside `subject_affinity`, and refactoring it out first would mean comparing against code written for this
// harness instead of the code that runs.
//
//   bun rust/parity/affinity_prompt.ts
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { subject_affinity } from "../../ts/src/codebase/grow/subject_affinity.js";
import { HostBus, set_host_bus } from "../../ts/src/core/llm.js";
import { loadAddon } from "../../ts/src/codebase/rust_core.js";

const addon = loadAddon();
if (!addon) { console.log("no addon"); process.exit(0); }

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..", "..");
const fixtures = join(REPO, "ts", "test", "fixtures");

let captured: string | null = null;
class CaptureBus extends HostBus {
  serve(tag: string, prompt: string, _m: string, _t: number | null): string {
    if (tag === "affinity") captured = prompt;
    return "[]";
  }
}

// Subjects are drawn from each repo's own identifiers, so the scan has something real to match on — a
// made-up subject would match nothing and compare empty against empty.
const subjectsOf = (repo: string): string[] => {
  const out = new Set<string>();
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!["node_modules", ".git", ".seam"].includes(e.name)) walk(join(d, e.name)); }
    else if (/\.(ts|tsx|js|java|rb|py|go)$/.test(e.name)) {
      const t = readFileSync(join(d, e.name), "utf-8");
      for (const m of t.matchAll(/\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/g)) out.add(m[1]);
    }
  } };
  try { walk(repo); } catch { /* unreadable fixture */ }
  return [...out].sort().slice(0, 6);
};

const repos = [
  ...readdirSync(fixtures).filter((d) => d.endsWith("-repo")).map((d) => join(fixtures, d)),
  join(fixtures, "booking-app"),
];

let ok = 0, bad = 0, compared = 0, withCands = 0, empty = 0;
const fails: string[] = [];
const firstLineDiff = (a: string, b: string): string => {
  const la = a.split("\n"), lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++)
    if (la[i] !== lb[i]) return `line ${i + 1}:\n    TS: ${JSON.stringify(la[i])}\n    RS: ${JSON.stringify(lb[i])}`;
  return "identical?";
};

for (const repo of repos) {
  const subjects = subjectsOf(repo);
  if (!subjects.length) continue;
  for (const cap of [3, 30]) {
    for (const exclude of [[] as string[], [subjectsOf(repo).length ? "src" : "x"]]) {
      captured = null;
      set_host_bus(new CaptureBus({}));
      try { await subject_affinity(repo, subjects, "how does a booking get confirmed?", { cap, exclude, votes: 1 }); }
      catch { /* best-effort pass; a throw is still a comparable outcome via `captured` */ }
      finally { set_host_bus(null); }

      const rs = JSON.parse(addon.growAffinityPrompt(repo, subjects, "how does a booking get confirmed?", exclude, cap));
      compared++;
      if (rs.candidates.length) withCands++; else empty++;

      const tsPrompt = captured ?? "";           // no candidates ⇒ TS never calls the bus ⇒ no prompt
      if (tsPrompt === rs.prompt) ok++;
      else { bad++; if (fails.length < 5) fails.push(`${repo.split("/").pop()} cap=${cap} ex=${exclude.length}\n  ${firstLineDiff(tsPrompt, rs.prompt)}`); }
    }
  }
}

console.log(`affinity-prompt parity: ${ok} ok / ${bad} bad   (compared ${compared}, with-candidates ${withCands}, empty ${empty})`);
for (const x of fails) console.log("  " + x);
if (bad) process.exit(1);
