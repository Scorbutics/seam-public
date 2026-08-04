// DOES THE SHIPPED RENDER ACTUALLY SURFACE MORE OF THE DEMAND? — the end-to-end gate on the hop-first change.
//
// `bun bench/ranking/render-head.ts [case-prefix] [--arm A|B]`
//
// WHY THIS EXISTS AND `rank-eval.ts` IS NOT ENOUGH. The scoreboard measures an ordering of FILES over the
// whole closure. The change that shipped reorders the MEMBERS the render surfaces inside each seam
// (`memberLines`, capped at 8 per seam, drawn only from `spine`-flagged hunks). Those are not the same thing,
// and "the file ordering improved" is not evidence that "the output improved" — this project has shipped that
// substitution before. So this reproduces the render's ACTUAL selection rule, old and new, over the same
// closures, and scores both against the same demand.
//
// WHAT IS REPRODUCED: `markSpineMembers` (cap = min(12, max(1, ceil(n/4))) over the seam's scored members)
// followed by `memberLines` (first 8, in rule order). OLD = relevance >= the seam's mean, ordered by
// relevance desc. NEW = nearest by `hops`, ties broken by relevance. Both read from the SAME emitted closure,
// which now carries both fields, so no rebuild or revert is needed to compare them.
import { demand, growOf, signals } from "./lib.ts";

const argv = process.argv.slice(2);
const ARM = (argv[argv.indexOf("--arm") + 1] === "B" ? "B" : "A") as "A" | "B";
const prefix = argv.find((a) => !a.startsWith("--") && a !== "A" && a !== "B") ?? "kc";
const HEAD = 12;
const MEMBER_CAP = 8;

type Hunk = { file?: string; relevance?: number; hops?: number; caller?: boolean; summary?: boolean };

/** the members one seam would surface, in render order — `rule` picks the ordering key */
function surfaced(hunks: Hunk[], rule: "old" | "new"): string[] {
  const scored = hunks.filter((h) => typeof h.relevance === "number");
  if (scored.length < 2) return scored.filter((h) => h.file).map((h) => h.file!);
  const cap = Math.min(12, Math.max(1, Math.ceil(scored.length / 4)));
  let picked: Hunk[];
  if (rule === "new" && scored.some((h) => typeof h.hops === "number")) {
    picked = [...scored].sort((a, b) => {
      const ha = typeof a.hops === "number" ? a.hops : Infinity;
      const hb = typeof b.hops === "number" ? b.hops : Infinity;
      return (ha - hb) || (b.relevance! - a.relevance!);
    }).filter((h) => typeof h.hops === "number").slice(0, cap);
  } else {
    const mean = scored.reduce((n, h) => n + h.relevance!, 0) / scored.length;
    picked = [...scored].sort((a, b) => b.relevance! - a.relevance!).filter((h) => h.relevance! >= mean).slice(0, cap);
  }
  return picked.slice(0, MEMBER_CAP).filter((h) => h.file).map((h) => h.file!);
}

type Row = { case: string; opens: number; ceiling: number; old: number; neu: number };
const rows: Row[] = [];
const skipped: string[] = [];

for (const id of [...new Set(demand.filter((c) => c.case.startsWith(prefix)).map((c) => c.case))].sort()) {
  const target = demand.find((c) => c.case === id && c.arm === ARM);
  const seamArm = demand.find((c) => c.case === id && c.arm === "B");
  if (!target || !seamArm) continue;
  const opens = [...target.reads, ...target.bashReads];
  if (!opens.length) continue;
  const growCmd = seamArm.seamCmds.filter((c) => /--center/.test(c) && !/--query/.test(c) && !/--locate/.test(c))
    .sort((a, b) => b.length - a.length)[0];
  if (!growCmd) continue;
  const grow = growOf(growCmd);
  if (!grow) { skipped.push(`${id}: grow replay produced nothing`); continue; }
  const seams: any[] = (grow.clusters ?? []).flatMap((c: any) => c.seams ?? []);
  if (!seams.length) { skipped.push(`${id}: closure has no seams`); continue; }

  // THE CLOSURE MUST CARRY `hops`, or "new" silently falls back to "old" and the two columns tie for a reason
  // that has nothing to do with the ranking. That tie would read as "the change did nothing".
  const anyHops = seams.some((s) => (s.hunks ?? []).some((h: any) => typeof h.hops === "number"));
  if (!anyHops) { skipped.push(`${id}: closure carries no 'hops' — stale cache, re-run after the engine build`); continue; }

  const sig = signals(grow);
  const cov = (rule: "old" | "new") => {
    const head: string[] = [];
    // seams in emitted order, each contributing its surfaced members, until the head is full — the render
    // reads top-down, so this is the order a consumer's attention actually goes in.
    for (const s of seams) { for (const f of surfaced(s.hunks ?? [], rule)) if (!head.includes(f)) head.push(f); if (head.length >= HEAD) break; }
    const set = new Set(head.slice(0, HEAD));
    return opens.filter((f) => set.has(f)).length / opens.length;
  };
  rows.push({
    case: id,
    opens: opens.length,
    ceiling: opens.filter((f) => sig.has(f)).length / opens.length,
    old: cov("old"),
    neu: cov("new"),
  });
}

if (!rows.length) {
  console.error(`ABORT: 0 case(s) scored for prefix '${prefix}', arm ${ARM}.`);
  for (const s of skipped) console.error(`   skipped — ${s}`);
  process.exit(3);
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const mean = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0) / rows.length;
console.log(`\n══════ RENDER HEAD — first ${HEAD} files the region view surfaces, arm ${ARM}, ${rows.length} case(s)\n`);
console.log(`   ${"case".padEnd(10)} ${"opens".padStart(6)} ${"ceiling".padStart(8)} ${"old (cosine)".padStart(13)} ${"new (hops)".padStart(11)}`);
for (const r of rows)
  console.log(`   ${r.case.padEnd(10)} ${String(r.opens).padStart(6)} ${pct(r.ceiling).padStart(8)} ${pct(r.old).padStart(13)} ${pct(r.neu).padStart(11)}`);
console.log(`   ${"".padEnd(10)} ${"".padStart(6)} ${"".padStart(8)} ${"─".repeat(13)} ${"─".repeat(11)}`);
console.log(`   ${"MEAN".padEnd(10)} ${"".padStart(6)} ${pct(mean((r) => r.ceiling)).padStart(8)} ${pct(mean((r) => r.old)).padStart(13)} ${pct(mean((r) => r.neu)).padStart(11)}`);
if (skipped.length) { console.log(`\n   ${skipped.length} case(s) skipped (NOT scored as zero):`); for (const s of skipped) console.log(`     ${s}`); }
console.log();
