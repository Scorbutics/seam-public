// FLYWHEEL DISCOVERY orchestration parity (Phase 5) — drive the Rust state machine on a tmp repo with a FIXED
// LLM answer, and compare the persisted .seam/key-adapters.json against the store computed by replicating
// learnKeyMatchers' deterministic post-LLM logic with the REAL TS validateMatcher + runMatcher. Validates the
// full flow (gate → parse/validate → detect gate → retry → dedup → persist + record) end-to-end.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { validateMatcher, matcherKey, runMatcher } from "../../ts/src/codebase/coupling/key_ir.js";

const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

// tmp repo with two blind files: a bus producer + a bus consumer.
const repo = mkdtempSync(join(tmpdir(), "seam-discover-"));
mkdirSync(join(repo, "svc"), { recursive: true });
const files: [string, string][] = [
  ["svc/pub.ts", "export function p() {\n  bus.publish('sync');\n  bus.publish('refresh');\n}\n"],
  ["svc/sub.ts", "export function s() {\n  bus.on('sync', () => {});\n}\n"],
];
for (const [rel, text] of files) writeFileSync(join(repo, rel), text);

// A FIXED LLM answer: 2 detecting channel rules (publish/on) + 1 non-detecting call rule (→ dropped, forces retry).
const answer1 = JSON.stringify([
  { via: "channel", token: "bus", verbs: ["publish"], kind: "event", role: "produces", name: "bus-pub", description: "publishes a bus event" },
  { via: "channel", token: "bus", verbs: ["on"], kind: "event", role: "consumes", name: "bus-on", description: "listens on a bus event" },
  { via: "call", token: "doesNotExistAnywhere", argIndex: 0, kind: "event", role: "produces" },
]);
const answer2 = "[]"; // retry adds nothing

// ── Rust: drive the state machine ──
const start = JSON.parse(addon.learnStart(repo, JSON.stringify(files), 10));
if (start.kind !== "prompt") { console.log(`FAIL: learnStart kind=${start.kind} (expected prompt)`); process.exit(1); }
const ing = JSON.parse(addon.learnIngest(JSON.stringify(files), JSON.stringify(start.snippets), answer1));
if (ing.kind === "retry") {
  addon.learnFinalize(repo, start.sig, JSON.stringify(files), JSON.stringify(ing.accepted), answer2);
} else {
  addon.learnCommit(repo, start.sig, JSON.stringify(ing.matchers));
}
const rustStore = readFileSync(join(repo, ".seam", "key-adapters.json"), "utf8");

// ── TS: replicate the deterministic post-LLM logic with real validateMatcher + runMatcher ──
const parse = (ans: string) => {
  const seen = new Set<string>(), out: any[] = [];
  for (const o of JSON.parse(ans)) { const m = validateMatcher(o); if (m) { const k = matcherKey(m); if (!seen.has(k)) { seen.add(k); out.push(m); } } }
  return out;
};
const detects = async (m: any) => { for (const [rel, text] of files) if ((await runMatcher(m, rel, text)).length) return true; return false; };
const cands = parse(answer1);
const accepted: any[] = [], failed: any[] = [];
for (const m of cands) ((await detects(m)) ? accepted : failed).push(m);
// retry (answer2=[]) adds nothing
const sig = createHash("sha1").update(files.map(([f, t]) => `${f}:${createHash("sha1").update(t).digest("hex")}`).sort().join("\n")).digest("hex");
const tsStore = JSON.stringify({ schema: 3, rules: accepted, files: {}, learnedSigs: [sig] }, null, 2);

// ── compare + replay check ──
let ok = rustStore === tsStore;
console.log(`discovery store: ${ok ? "byte-identical OK" : "DIFF"} (${accepted.length} rules learned)`);
if (!ok) {
  let i = 0; while (i < Math.min(rustStore.length, tsStore.length) && rustStore[i] === tsStore[i]) i++;
  console.log(`  DIFF at byte ${i}: TS ${tsStore.length}B / Rust ${rustStore.length}B`);
  console.log("  TS  …", JSON.stringify(tsStore.slice(Math.max(0, i - 30), i + 40)));
  console.log("  Rust…", JSON.stringify(rustStore.slice(Math.max(0, i - 30), i + 40)));
}
// replay: a second learnStart with the same blind files must REPLAY (no prompt), returning the learned rules.
const replay = JSON.parse(addon.learnStart(repo, JSON.stringify(files), 10));
const replayOk = replay.kind === "replay" && replay.matchers.length === accepted.length;
console.log(`  replay-on-relearn: ${replayOk ? "OK" : `DIFF (kind=${replay.kind} n=${replay.matchers?.length})`}`);

rmSync(repo, { recursive: true, force: true });
process.exit(ok && replayOk ? 0 : 1);
