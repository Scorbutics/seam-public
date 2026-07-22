// PHASE 1 byte-identical harness — Rust scan_consumers vs TS scan_consumers. Anchors = (java file, its class
// name). Consumers are order-sensitive (walk order), so the whole Consumer[] is compared, not a set.
//   bun rust/parity/consumers.ts [repo] [maxAnchors]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { scan_consumers } from "../../ts/src/core/resolve/consumers.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxAnchors = parseInt(process.argv[3] ?? "500", 10);

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString()
  .split("\0")
  .filter(Boolean);
const classOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1, -5);

// anchors: files that ARE imported somewhere are the interesting ones; just sample across the tree.
const anchors: [string, string][] = files.slice(0, maxAnchors).map((f) => [f, classOf(f)]);

const key = (c: any) => `${c.file}|${c.local}|${c.source}|${c.status}|${c.reexport ? 1 : 0}`;
const dump = (cs: any[]) => cs.map(key).join("\n");

const rust: any[][] = addon.scanConsumersBatch(repo, anchors);

let ok = 0;
let bad = 0;
let withConsumers = 0;
const fails: string[] = [];
for (let i = 0; i < anchors.length; i++) {
  const [file, symbol] = anchors[i];
  const ts = await scan_consumers(repo, file, symbol);
  if (ts.length) withConsumers++;
  const t = dump(ts);
  const r = dump(rust[i]);
  if (t === r) ok++;
  else {
    bad++;
    if (fails.length < 8) {
      const tl = t.split("\n");
      const rl = r.split("\n");
      let first = "(count)";
      for (let j = 0; j < Math.max(tl.length, rl.length); j++)
        if (tl[j] !== rl[j]) {
          first = `    ts:   ${tl[j] ?? "∅"}\n    rust: ${rl[j] ?? "∅"}`;
          break;
        }
      fails.push(`  ${file}#${symbol}  (ts=${ts.length} rust=${rust[i].length})\n${first}`);
    }
  }
}
console.log(`scan_consumers parity over ${anchors.length} anchors (${withConsumers} with ≥1 consumer):`);
console.log(`  ✅ identical: ${ok}\n  ❌ mismatch:  ${bad}`);
if (bad) {
  console.log(fails.join("\n"));
  process.exit(1);
}
console.log("→ byte-identical scan_consumers");
