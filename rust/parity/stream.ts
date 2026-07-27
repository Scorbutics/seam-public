// STREAM PARITY — the Rust wave's per-wave records vs the TS wave's, on the same repo.
//
// `--stream` is a PUBLISHED contract (docs/SEAM_JSON_CONTRACT.md): one NDJSON record per settled wave, the
// seed as wave 0, and the union of every record's `added` equal to the final region. It was the last thing
// pinning a query to the TS engine, because the addon returned a graph ONCE at the end and had no way to emit
// anything mid-walk.
//
// What this checks is the SEQUENCE, not just the totals: a stream that produces the right final region in the
// wrong number of waves — or that emits everything in one record at the end — satisfies "the union matches"
// while destroying the feature's whole purpose (seeing wave N while N+1 computes). So compare record by record.
//
//   bun rust/parity/stream.ts [repo] [file] [symbol]
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../ts/src/codebase/grow/orchestrate.js";

const [, , argRepo, argFile, argSym] = process.argv;
// Default: a 6-deep chain, so the flood spans several waves and the seed cannot contain the whole region —
// a one-wave repo would pass any implementation, including a replay-at-the-end one.
let repo = argRepo, file = argFile ?? "chain/h0.ts", symbol = argSym ?? "step0", temp = "";
if (!repo) {
  temp = repo = join(tmpdir(), "seam-stream-parity-" + process.pid);
  rmSync(repo, { recursive: true, force: true });
  const w = (rel: string, t: string) => { const p = join(repo!, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
  w("package.json", `{ "name": "stream", "version": "1.0.0" }\n`);
  for (let i = 0; i < 5; i++) w(`chain/h${i}.ts`, `import { step${i + 1} } from "./h${i + 1}";\nexport function step${i}() { return step${i + 1}(); }\n`);
  w("chain/h5.ts", `export function step5() { return "terminal"; }\n`);
}

const run = async (rust: boolean) => {
  if (rust) delete process.env.SEAM_RUST_CORE; else process.env.SEAM_RUST_CORE = "0";
  const recs: any[] = [];
  await grow_to_terminals(repo!, file, symbol, { dataCoupling: false, onWave: (r: any) => recs.push(r) } as any);
  return recs;
};
const rs = await run(true), ts = await run(false);
if (temp) rmSync(temp, { recursive: true, force: true });

// A record's identity: its wave number and the CONTENT it carries (ids are engine-local, so compare by
// file#symbol and by endpoint content, exactly as the graph harnesses do).
const nodeKey = (a: any) => `${a.file}#${a.symbol}#${a.kind}`;
const recKey = (r: any) => `w${r.wave}|${r.added.map(nodeKey).sort().join(",")}|${r.edges.length}e|${r.frontier.length}f`;
const rk = rs.map(recKey), tk = ts.map(recKey);

let diff = -1;
for (let i = 0; i < Math.max(rk.length, tk.length); i++) if (rk[i] !== tk[i]) { diff = i; break; }

console.log(`\nstream parity ${file}#${symbol}  (${repo})`);
console.log(`  records: TS=${tk.length} Rust=${rk.length}`);
console.log(`  per-wave: TS   ${ts.map((r) => `w${r.wave}:+${r.added.length}n/${r.edges.length}e`).join(" ")}`);
console.log(`            Rust ${rs.map((r) => `w${r.wave}:+${r.added.length}n/${r.edges.length}e`).join(" ")}`);
if (diff >= 0) console.log(`  first differing record @${diff}:\n    ts:   ${tk[diff]}\n    rust: ${rk[diff]}`);

const ok = diff === -1 && rk.length === tk.length;
console.log(ok ? "\n→ the two engines emit the SAME wave sequence" : "\n→ DIVERGENT — the stream would render differently");
process.exit(ok ? 0 : 1);
