// AGGREGATE N RUNS OF ONE CONFIGURATION — because n=1 on this benchmark measures nothing.
//
//   bun bench/grep-vs-seam/aggregate.ts <case-id>…
//
// WHY. Both arms are LLM agents and the run-to-run spread is enormous. Measured 2026-07-31 on cal-booking-flow,
// three runs whose only differences were documentation:
//
//   ARM SEAM tool calls:  32, 19, 32       ARM GREP tool calls:  25, 40, 29
//
// A 13-call swing between consecutive runs is larger than any effect that had been claimed from single samples
// that day — including a "32 -> 19" reported as if a change had caused it, when the middle run had no change at
// all. Every per-change delta quoted from one run was inside the noise.
//
// So this reports MEDIAN and SPREAD over repeats, and refuses to compare two configurations whose ranges
// overlap. It is deliberately blunt about that: the failure mode here is not a wrong number, it is a real
// number presented as evidence for a cause it cannot support.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const ids = process.argv.slice(2);
if (ids.length < 2) { console.error("usage: aggregate.ts <case-id> <case-id> [...]   (at least 2; 3+ recommended)"); process.exit(2); }
const OUT = join(dirname(new URL(import.meta.url).pathname), "results");

type Row = { calls: number; secs: number; blocked: number };
const read = (id: string, letter: string): Row | null => {
  const p = join(OUT, `${id}.${letter}.jsonl`);
  if (!existsSync(p)) return null;
  let calls = 0, blocked = 0;
  const pend = new Set<string>();
  for (const line of readFileSync(p, "utf-8").split("\n").filter(Boolean)) {
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    for (const b of ev?.message?.content ?? []) {
      if (b?.type === "tool_use") pend.add(b.id);
      if (b?.type === "tool_result" && pend.has(b.tool_use_id)) {
        const raw = b.content;
        const t = typeof raw === "string" ? raw : (Array.isArray(raw) ? raw.map((x: any) => x?.text ?? "").join(" ") : "");
        if (/has been denied|Permission to use/.test(t)) blocked++; else calls++;
        pend.delete(b.tool_use_id);
      }
    }
  }
  const sp = join(OUT, `${id}.${letter}.secs`);
  return { calls, blocked, secs: existsSync(sp) ? Number(readFileSync(sp, "utf-8").trim()) : 0 };
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

console.log(`═══ ${ids.length} run(s): ${ids.join(", ")}\n`);
const summary: Record<string, { calls: number[]; secs: number[] }> = {};
for (const [letter, label] of [["A", "ARM GREP"], ["B", "ARM SEAM"]] as const) {
  const rows = ids.map((id) => read(id, letter)).filter(Boolean) as Row[];
  if (rows.length < ids.length) console.log(`   (${label}: only ${rows.length}/${ids.length} runs present)`);
  const calls = rows.map((r) => r.calls), secs = rows.map((r) => r.secs);
  summary[label] = { calls, secs };
  console.log(`── ${label}`);
  console.log(`   tool calls   median ${median(calls)}   range ${Math.min(...calls)}–${Math.max(...calls)}   raw [${calls.join(", ")}]`);
  console.log(`   wall clock   median ${median(secs)}s  range ${Math.min(...secs)}–${Math.max(...secs)}s  raw [${secs.join(", ")}]\n`);
}

// THE SPREAD IS THE HEADLINE, not a footnote. If it is wide, say what that forbids.
const b = summary["ARM SEAM"].calls, a = summary["ARM GREP"].calls;
const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
console.log(`── what this can and cannot detect`);
console.log(`   ARM SEAM spread ${spread(b)} call(s); ARM GREP spread ${spread(a)} call(s).`);
console.log(`   A change is only visible here if it moves the median by MORE than the spread. Anything smaller`);
console.log(`   needs more runs, not a confident sentence. Compare configurations by their RANGES: if the two`);
console.log(`   ranges overlap, the honest report is "no detectable difference at this n".`);
