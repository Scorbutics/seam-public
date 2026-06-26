// DIAGNOSTIC — why does a grow go DOWN instead of UP? Prints, for an anchor (file + symbol):
//   1. how the anchor unit is CLASSIFIED (method vs function — gates the call-site pass)
//   2. the import-scan consumers (scan_consumers)
//   3. the receiver-agnostic CALL-SITE consumers (build_callsite_graph) — the DI/`obj.m()` callers
//   4. the SEED up-footprint nodes with their direction
//   5. the grow history + final nodes (does it climb to consumers or descend into deps?)
//
//   bun ts/tools/why_grow.ts <repo> <relative/path/to/File.java> <symbol>
// e.g. bun ts/tools/why_grow.ts /path/to/globex ejb/src/main/java/com/acme/cdi/booking/BookingBean.java createBooking
import { makeCtx, available } from "../src/codebase/atoms.js";
import { _named_units, _read } from "../src/codebase/scan/ast_units.js";
import { scan_consumers } from "../src/core/resolve/consumers.js";
import { build_callsite_graph } from "../src/codebase/scan/class_graph.js";
import { build_footprint } from "../src/codebase/scan/footprint.js";
import { grow_to_terminals } from "../src/codebase/grow/orchestrate.js";

const [repo, file, symbol] = process.argv.slice(2);
if (!repo || !file || !symbol) { console.error("usage: why_grow <repo> <relfile> <symbol>"); process.exit(1); }
if (!available()) { console.log("tree-sitter NOT available — cannot diagnose"); process.exit(0); }

const rd = _read(repo, file);
if (!rd) { console.error(`cannot read ${file} under ${repo}`); process.exit(1); }
const ctx = (await makeCtx(rd[0], rd[1]))!;
const unit = _named_units(ctx).find((u) => u[0] === symbol);
console.log(`\n[1] anchor unit: ${unit ? `${unit[0]} kind=${unit[1]}` : "NOT FOUND as a named unit (→ falls back to 'symbol', call-site pass SKIPPED)"}`);

console.log("\n[2] import-scan consumers (scan_consumers):");
const sc = await scan_consumers(repo, file, symbol);
if (!sc.length) console.log("   (none — expected for a method; methods aren't imported)");
for (const c of sc) console.log(`   ${c.status}  ${c.file}`);

console.log("\n[3] receiver-agnostic call-site consumers (build_callsite_graph — the DI/obj.m() callers):");
const cs = await build_callsite_graph(repo, file, symbol, { methodNames: new Set([symbol]) });
const csCon = cs.nodes.filter((n: any) => n.id !== "n1");
if (!csCon.length) console.log("   *** NONE *** — the call sites are not being matched (THIS is why the grow has no upward frontier)");
for (const n of csCon) console.log(`   ${n.symbol} [${n.kind}] ${n.file}`);
for (const e of cs.edges) console.log(`     edge ${e.from}→${e.to} ${e.kind} ${e.provenance ?? ""}`);

console.log("\n[4] SEED up-footprint (direction 'up'):");
const up = await build_footprint(repo, file, symbol, { direction: "up" });
for (const n of up.nodes) console.log(`   ${n.symbol} [${n.kind}] ${n.file} dir=${n.direction ?? "-"}${n.coupling ? " COUPLING" : ""}`);

console.log("\n[5] grow_to_terminals (history → does it climb to consumers or descend?):");
const [data, hist] = await grow_to_terminals(repo, file, symbol, { maxSteps: 8, dataCoupling: true });
for (const h of hist) console.log("   step:", JSON.stringify(h));
console.log("   final nodes:");
for (const n of data.nodes) console.log(`     ${n.symbol} [${n.kind}] ${n.file} dir=${n.direction ?? "-"}${n.coupling ? " COUPLING" : ""}`);
