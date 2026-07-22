// Byte-identical harness — Rust resolve_coupling vs TS resolveCoupling (deterministic floor path:
// dataCoupling ON, llm OFF), over whole-file spans of Keycloak files that touch a boundary. Exercises the APPLY
// pipeline: collect → ground-lookup → draw boundary → wire near + cross far + chain, incl. same-side co-writers.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveCoupling, floor_base_index } from "../../ts/src/codebase/coupling/index.js";
import { SKIP_DIRS } from "../../ts/src/core/resolve/languages/index.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "120", 10);
const onlyExt = process.argv[4] ?? ".java";

// files that touch a boundary = the distinct producer/consumer files of the floor index
const floorRows = addon.floorIndex(repo) as string[][];
const files = [...new Set(floorRows.map((r) => r[2]))].filter((f) => f.endsWith(onlyExt)).sort().slice(0, maxFiles);

const serNodes = (nodes: any[]) => nodes.map((n) => `${n.id}|${n.symbol}|${n.kind}|${n.file}|${n.range[0]}-${n.range[1]}|${n.enclosing ?? ""}|${n.complexity}|${n.direction ?? ""}`);
const serEdges = (edges: any[]) => edges.map((e) => `${e.from}|${e.to}|${e.kind}|${e.line ?? ""}|${e.op ?? ""}`);
const serBlind = (bs: any[]) => bs.map((b) => `${b.node}|${b.mechanism}|${b.evidence}|${(b.candidates ?? []).map((c: any) => `${c.file}#${c.symbol}#${c.provenance}`).join(",")}`);

// warm the floor ONCE on a reference ctx, then fork() per file (shares the immutable floor caches, fresh budgets)
const ref = new EngineCtx();
floor_base_index(repo, SKIP_DIRS, ref);

let ok = 0, bad = 0, nonEmpty = 0;
const fails: string[] = [];
for (const rel of files) {
  let text: string; try { text = readFileSync(`${repo}/${rel}`, "utf8"); } catch { continue; }
  if (!/^[\x00-\x7F]*$/.test(text)) continue;                   // ASCII only (dodge the line_of byte/UTF-16 delta)
  const hi = text.split("\n").length;
  const ctx = ref.fork();
  if (process.env.SEAM_STABLE) ctx.stableFloor = true;   // SEAM_STABLE=1 → pure floor; default = FULL path (learned matchers + effect-inference on)
  const ts = await resolveCoupling(repo, "n1", rel, text, 0, hi, 0, { dataCoupling: true, llm: false }, ctx);
  const rust = addon.resolveCoupling(repo, "n1", rel, text, 0, hi, 0, !!process.env.SEAM_STABLE);
  if (ts.nodes.length) nonEmpty++;
  const tn = serNodes(ts.nodes).join(";"), rn = (rust.nodes as string[]).join(";");
  const te = serEdges(ts.edges).join(";"), re = (rust.edges as string[]).join(";");
  const tb = serBlind(ts.blindspots).join("\n"), rb = (rust.blindspots as string[]).join("\n");
  if (tn === rn && te === re && tb === rb && ts.counter === rust.counter) ok++;
  else {
    bad++;
    if (fails.length < 8) {
      let why = "";
      if (tn !== rn) why += `\n  NODES\n   ts:   ${tn}\n   rust: ${rn}`;
      if (te !== re) why += `\n  EDGES\n   ts:   ${te}\n   rust: ${re}`;
      if (tb !== rb) why += `\n  BLIND\n   ts:   ${tb}\n   rust: ${rb}`;
      if (ts.counter !== rust.counter) why += `\n  COUNTER ts=${ts.counter} rust=${rust.counter}`;
      fails.push(`✗ ${rel}${why}`);
    }
  }
}
console.log(`\nresolveCoupling parity over ${repo} (${onlyExt}, ${files.length} files, dataCoupling:true llm:false)`);
console.log(`  ${ok} ok / ${bad} bad   (non-empty: ${nonEmpty})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
