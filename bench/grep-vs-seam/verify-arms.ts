// THE BIAS CONTROL, AUDITED AFTER THE FACT — because in this benchmark it has broken twice.
//
//   bun bench/grep-vs-seam/verify-arms.ts <case-id>
//
// Run 4's arm GREP inherited MCP servers and could reach Seam tools, which silently converted the CONTROL arm
// into a second treatment arm. The result looked like a measurement and was not one. `run-arms.sh` now enforces
// the split with `--allowedTools`, but an allowlist is a claim about what COULD happen; this reads the actual
// transcript and reports what DID. Two independent mechanisms, because one has already failed.
//
// It also extracts the things score.ts needs and the old hand-run protocol never captured: wall clock, the tool
// call count, and the canonical `## ANSWER` block.
//
// EXITS NON-ZERO ON CONTAMINATION. A contaminated arm is not a weaker result, it is not a result — publishing it
// next to a clean one invites exactly the comparison it cannot support.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const caseId = process.argv[2];
if (!caseId) { console.error("usage: verify-arms.ts <case-id>"); process.exit(2); }
const OUT = join(dirname(new URL(import.meta.url).pathname), "results");

type Audit = { arm: string; calls: number; cmds: string[]; answer: string; secs: number; text: string };

const readArm = (letter: string): Audit => {
  const p = join(OUT, `${caseId}.${letter}.jsonl`);
  if (!existsSync(p)) { console.error(`ABORT: ${p} missing — run run-arms.sh first.`); process.exit(3); }
  const cmds: string[] = [];
  let text = "";
  for (const line of readFileSync(p, "utf-8").split("\n").filter(Boolean)) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    // tool invocations live in assistant messages as tool_use blocks
    for (const b of ev?.message?.content ?? []) {
      if (b?.type === "tool_use") {
        const c = b.input?.command ?? b.input?.pattern ?? b.input?.file_path ?? "";
        cmds.push(`${b.name}: ${String(c).slice(0, 300)}`);
      }
      if (b?.type === "text") text += b.text + "\n";
    }
    if (ev?.type === "result" && typeof ev.result === "string") text += ev.result + "\n";
  }
  const secsPath = join(OUT, `${caseId}.${letter}.secs`);
  const secs = existsSync(secsPath) ? Number(readFileSync(secsPath, "utf-8").trim()) : 0;
  // The canonical block, and ONLY it. Everything before `## ANSWER` is reasoning and is deliberately not scored:
  // scoring prose is how this harness twice produced a false accusation against the engine.
  const m = text.match(/^##\s*ANSWER\s*$([\s\S]*)/m);
  return { arm: letter, calls: cmds.length, cmds, answer: (m?.[1] ?? "").trim(), secs, text };
};

const A = readArm("A"), B = readArm("B");

// ── contamination ────────────────────────────────────────────────────────────────────────────────────────────
// Arm GREP must never reach Seam; arm SEAM must never reach a text search. Checked on what was actually RUN.
//
// KNOWLEDGE SOURCE vs PRESENTATION — the distinction this check has to make, and got wrong first time.
// A text search that ORIGINATES the data is contamination. One that filters the other tool's stdout is
// formatting. Arm SEAM's first run piped Seam's output through `grep '^-' | sed …` to build the answer block,
// six times, and a token match on "grep" called that a broken bias control. It was not: the knowledge came from
// Seam, and grep never touched the repo.
//
// So the rule is POSITIONAL. Only the HEAD of a pipeline reads the repository; every later segment reads its
// predecessor's stdout. A search in segment 0 is a search; a search after a `|` is a formatter. Loosening this
// any further — e.g. ignoring greps that merely "look like formatting" — would be tuning the control until it
// passes, which is how a bias control dies quietly.
const segments = (c: string): string[] => {
  const body = c.replace(/^\w+:\s*/, "");                 // strip the "Bash: " / "Grep: " tool prefix
  return body.split(/\|\||&&|;|\|/).map((s) => s.trim()).filter(Boolean);
};
const headIsSearch = (c: string): boolean => {
  if (/^(Grep|Glob):/.test(c)) return true;               // the native search TOOLS are always a repo search
  const segs = segments(c);
  return segs.length > 0 && /^(rg|grep|egrep|fgrep|ag|ack)\b/.test(segs[0]);
};
const headIsSeam = (c: string): boolean => {
  const segs = segments(c);
  return segs.some((s, i) => i === 0 && /decompose\.ts|(^|\/)seam\b/.test(s));
};
const usedSeam = (a: Audit) => a.cmds.filter(headIsSeam);
const usedGrep = (a: Audit) => a.cmds.filter(headIsSearch);

const bad: string[] = [];
const aSeam = usedSeam(A), bGrep = usedGrep(B);
if (aSeam.length) bad.push(`ARM GREP (A) invoked Seam ${aSeam.length}×:\n    ${aSeam.slice(0, 5).join("\n    ")}`);
if (bGrep.length) bad.push(`ARM SEAM (B) invoked a text search ${bGrep.length}×:\n    ${bGrep.slice(0, 5).join("\n    ")}`);

console.log(`═══ ${caseId} — arm audit`);
for (const a of [A, B]) {
  const name = a.arm === "A" ? "ARM GREP" : "ARM SEAM";
  console.log(`\n── ${name}`);
  console.log(`   wall clock      ${a.secs}s`);
  console.log(`   tool calls      ${a.calls}`);
  console.log(`   answer block    ${a.answer ? `${a.answer.split("\n").filter(Boolean).length} line(s)` : "MISSING"}`);
}

// An arm that produced no canonical block cannot be scored for precision, and silently scoring its prose instead
// is the exact regression this contract was introduced to prevent. Say so and stop.
for (const a of [A, B]) {
  if (!a.answer) {
    console.error(`\nABORT: arm ${a.arm} produced no "## ANSWER" block. Not scorable for precision —`);
    console.error(`falling back to prose would re-introduce the style-scoring defect. Re-run that arm.`);
    process.exit(3);
  }
}

if (bad.length) {
  console.error(`\nABORT — BIAS CONTROL FAILED:\n  ${bad.join("\n  ")}`);
  console.error(`\nA contaminated arm is not a weaker result, it is not a result. Discard this run.`);
  process.exit(3);
}

for (const a of [A, B]) writeFileSync(join(OUT, `${caseId}.${a.arm}.answer.txt`), a.answer + "\n");
console.log(`\n   bias control: CLEAN (arm GREP ran no Seam; arm SEAM ran no text search)`);
console.log(`   wrote ${caseId}.A.answer.txt and ${caseId}.B.answer.txt`);
