// Byte-identical harness — the Rust receiver-classification CANDIDATE SET vs the TS one (receiver_class.ts).
//
// The candidate set is the half that needs no model: walk the repo, profile every recurring dotted receiver by
// the verbs called on it, and keep the EXTERNAL ones that are both read and written. It decides what the
// classifier is ever ASKED about — so a drift here is silent: a data layer that never becomes a candidate can
// never become a matcher, and the coupling it carries simply never grounds. The classification itself needs a
// model and is pinned by the Rust unit tests instead.
//
// The comparison is over the PROMPT LINES, which double as the learn-once SIGNATURE: if these differ, the two
// engines would also disagree about whether a repo has already been learned, and one of them would re-pay.
//
//   bun rust/parity/receiverclass.ts [repo]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/cal.com";

// The TS candidate set is internal to classifyAndPersistRepositories, so drive it the way the engine does and
// read the profile lines back out of the module's own helpers.
const rc: any = await import("../../ts/src/codebase/coupling/receiver_class.js");
if (typeof rc._candidatesForParity !== "function") {
  console.log("receiver-class parity: SKIPPED — ts/src/codebase/coupling/receiver_class.ts exposes no");
  console.log("  `_candidatesForParity` hook, so the TS candidate set cannot be read without running the LLM pass.");
  console.log("  Add one (returning `_candidates(_inventory(repo, SKIP_DIRS))`) to enable this comparator.");
  process.exit(3);
}

const tsLines: string[] = rc._candidatesForParity(repo).map((p: any) => rc._profileLineForParity(p));
const rsLines: string[] = addon.receiverCandidates(repo).map((p: any) => p.line);

let bad = 0;
const onlyTs = tsLines.filter((l) => !rsLines.includes(l));
const onlyRs = rsLines.filter((l) => !tsLines.includes(l));
const orderSame = tsLines.join("\n") === rsLines.join("\n");
if (onlyTs.length || onlyRs.length) bad++;
if (!orderSame) bad++;   // the ORDER is part of the signature, not a presentation detail

console.log(`\nreceiver-class candidate parity over ${repo}`);
console.log(`  candidates: ts=${tsLines.length} rust=${rsLines.length}   order-identical: ${orderSame}`);
console.log(`  only-ts: ${onlyTs.length}   only-rust: ${onlyRs.length}`);
for (const l of onlyTs.slice(0, 6)) console.log(`  ✗ only ts:   ${l.slice(0, 120)}`);
for (const l of onlyRs.slice(0, 6)) console.log(`  ✗ only rust: ${l.slice(0, 120)}`);
if (!tsLines.length && !rsLines.length) { console.log("  REFUSING to pass: neither engine found a candidate — this proved nothing."); process.exit(2); }
process.exit(bad ? 1 : 0);
