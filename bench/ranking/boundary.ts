// WHY THE BOUNDARY TERM DOES NOT PAY — a diagnostic, not a scoreboard.
//
// `bun bench/ranking/boundary.ts [case-prefix] [--arm A|B]`
//
// THE FINDING IT EXPLAINS. `hops` (BFS distance from the anchor) beats or ties `struct` (`hops` + distance to
// the nearest route/table/queue node) in 7 of 9 repo families. Half the intended structural signal is earning
// nothing. Three explanations are possible and they have opposite fixes, so this measures which:
//
//   SATURATION      `toB` is near-constant — almost every file is 0 or 1 hop from some medium node — so
//                   adding it shifts every score by the same amount and cannot reorder. Fix: a boundary term
//                   with resolution (which boundary, not any boundary).
//   NO SIGNAL       `toB` varies, but demanded and undemanded files have the SAME distribution of it. Being
//                   near a route simply does not predict that an agent opens the file. Fix: drop the term.
//   ACTIVE HARM     `toB` varies and is ANTI-correlated — the files agents open are FURTHER from a medium
//                   node than the ones they ignore, so adding it demotes the right answers. Fix: drop it,
//                   and understand why the intuition inverted.
//
// The discriminator is P(open | signal = k): for each distance k, what share of the demand lands on files at
// that distance, against what share of the CANDIDATES sit there. A signal that orders demand concentrates it
// at low k; a signal with no information reproduces the candidate distribution.
//
// `hops` is measured the same way in the same table, as the positive control. A diagnostic that only examines
// the losing signal cannot tell "this term is useless" from "no term works here".
import { demand, growOf, signals, type Sig } from "./lib.ts";

const argv = process.argv.slice(2);
const ARM = (argv[argv.indexOf("--arm") + 1] === "B" ? "B" : "A") as "A" | "B";
const prefix = argv.find((a) => !a.startsWith("--") && a !== "A" && a !== "B") ?? "kc";
const K = 12;

type Obs = { sig: Sig; opens: number };
const obs: Obs[] = [];
const lostByStruct: { case: string; file: string; opens: number; hops: number; toB: number }[] = [];
let scored = 0;

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
  if (!grow) continue;
  const sig = signals(grow);
  if (sig.size < 20) continue;
  scored++;

  const want = new Map<string, number>();
  for (const f of opens) want.set(f, (want.get(f) ?? 0) + 1);
  for (const s of sig.values()) obs.push({ sig: s, opens: want.get(s.file) ?? 0 });

  // THE ACTUAL HARM, named file by file. A mean is not an explanation: if the boundary term costs coverage,
  // it costs it by pushing SPECIFIC demanded files out of the head, and those files are the evidence.
  const byFile = (a: Sig, b: Sig) => a.file.localeCompare(b.file);
  const cands = [...sig.values()];
  const headH = new Set([...cands].sort((a, b) => a.hops - b.hops || b.cites - a.cites || byFile(a, b)).slice(0, K).map((s) => s.file));
  const headS = new Set([...cands].sort((a, b) => a.through - b.through || b.cites - a.cites || byFile(a, b)).slice(0, K).map((s) => s.file));
  for (const [f, n] of want) {
    if (headH.has(f) && !headS.has(f)) {
      const s = sig.get(f)!;
      lostByStruct.push({ case: id, file: f, opens: n, hops: s.hops, toB: s.toB });
    }
  }
}

if (!scored) { console.error(`ABORT: 0 case(s) scored for prefix '${prefix}'.`); process.exit(3); }

// ── P(open | signal = k) ─────────────────────────────────────────────────────────────────────────────────────
const totalOpens = obs.reduce((n, o) => n + o.opens, 0);
const fmt = (n: number) => (Number.isFinite(n) ? String(n) : "∞");
function table(name: string, get: (s: Sig) => number) {
  const buckets = new Map<number, { files: number; opens: number }>();
  for (const o of obs) {
    const k = get(o.sig);
    const b = buckets.get(k) ?? { files: 0, opens: 0 };
    b.files++; b.opens += o.opens;
    buckets.set(k, b);
  }
  console.log(`\n   ── ${name}`);
  console.log(`   ${"k".padStart(4)} ${"files".padStart(7)} ${"cand%".padStart(7)} ${"opens".padStart(7)} ${"demand%".padStart(8)}   lift`);
  for (const [k, b] of [...buckets].sort((a, b) => a[0] - b[0])) {
    const candPc = b.files / obs.length, demPc = totalOpens ? b.opens / totalOpens : 0;
    // LIFT = demand share / candidate share. 1.0 means this bucket holds exactly its proportional share of
    // the demand — i.e. the signal said nothing. A signal that orders demand shows lift falling with k.
    const lift = candPc > 0 ? demPc / candPc : 0;
    console.log(`   ${fmt(k).padStart(4)} ${String(b.files).padStart(7)} ${(candPc * 100).toFixed(1).padStart(6)}% ${String(b.opens).padStart(7)} ${(demPc * 100).toFixed(1).padStart(7)}%   ${lift.toFixed(2)}`);
  }
}

console.log(`\n══════ BOUNDARY DIAGNOSTIC — prefix '${prefix}', arm ${ARM}, ${scored} case(s), ${obs.length} candidate file(s), ${totalOpens} open(s)`);
table("hops — distance from the anchor (the positive control)", (s) => s.hops);
table("toB — distance to the nearest route/table/egress node (the term under test)", (s) => s.toB);

// ── does toB separate demand at a FIXED hops? ────────────────────────────────────────────────────────────────
// The two signals are correlated, so a raw toB table can inherit its ordering from hops. Holding hops fixed is
// the only way to see whether the boundary term carries information hops does not already have.
console.log(`\n   ── toB WITHIN a fixed hops band (does the term add anything hops has not already said?)`);
console.log(`   ${"hops".padStart(4)} ${"toB".padStart(4)} ${"files".padStart(7)} ${"opens".padStart(7)} ${"open/file".padStart(10)}`);
const cells = new Map<string, { files: number; opens: number }>();
for (const o of obs) {
  if (!Number.isFinite(o.sig.hops) || o.sig.hops > 4) continue;
  const key = `${o.sig.hops}|${o.sig.toB}`;
  const c = cells.get(key) ?? { files: 0, opens: 0 };
  c.files++; c.opens += o.opens;
  cells.set(key, c);
}
for (const [key, c] of [...cells].sort((a, b) => {
  const [ah, at] = a[0].split("|").map(Number), [bh, bt] = b[0].split("|").map(Number);
  return ah - bh || at - bt;
})) {
  const [h, t] = key.split("|");
  console.log(`   ${h.padStart(4)} ${fmt(Number(t)).padStart(4)} ${String(c.files).padStart(7)} ${String(c.opens).padStart(7)} ${(c.opens / c.files).toFixed(2).padStart(10)}`);
}

// ── what the boundary term actually cost ─────────────────────────────────────────────────────────────────────
console.log(`\n   ── demanded files that 'hops' put in the top-${K} and 'struct' pushed out`);
if (!lostByStruct.length) console.log(`   (none — the term costs nothing here, it merely adds nothing)`);
for (const l of lostByStruct.sort((a, b) => b.opens - a.opens))
  console.log(`   ${String(l.opens).padStart(3)} open(s)  hops=${fmt(l.hops)} toB=${fmt(l.toB)}  ${l.case}  ${l.file}`);
console.log();
