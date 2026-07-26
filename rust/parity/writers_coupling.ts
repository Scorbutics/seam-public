// Byte-identical harness — Rust `project_writers` / `project_coupling` vs the TS `writers` / `coupling`
// shapes. Those two live in the CLI (ts/src/cli/queries.ts), not in an importable model module, so the ORACLE
// is the CLI itself: each anchor is run with `--emit-seams` and the emitted MODEL is compared field by field.
// That is stricter than importing a helper would be — it pins the whole answer the user actually receives.
//
//   bun rust/parity/writers_coupling.ts [repo] [maxAnchors]
//
// Anchors are chosen for RELEVANCE, not evenly: a shape about shared keys is only exercised by a file that
// TOUCHES one, so anchors are drawn from files the coupling floor already grounds. An evenly-sampled anchor
// set would be ~90% "no key here", and a harness that compares empties reads green while proving nothing —
// so the non-trivial count is reported and a run that finds none exits non-zero.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/cal.com";
const maxAnchors = parseInt(process.argv[3] ?? "10", 10);
const CLI = "/home/scorbutics/seam-phase0/ts/src/cli/decompose.ts";

// Files with db-table keys, from the addon's own floor scan — then one function/method anchor per file.
const defs = (addon.enumerateDefs(repo, 200000, undefined, false) as any[])
  .filter((d) => /\.(ts|tsx|js)$/.test(d.file) && ["function", "method"].includes(d.kind) && d.name);
const keyed = new Set<string>();
for (const d of defs) {
  if (keyed.size >= maxAnchors * 4) break;
  try {
    const text = readFileSync(`${repo}/${d.file}`, "utf-8");
    if (addon.scanFileKeys(d.file, text).some((h: string[]) => h[0] === "db-table")) keyed.add(d.file);   // rows: [kind,value,line,produces,…]
  } catch { /* unreadable → skip */ }
}
const anchors = defs.filter((d) => keyed.has(d.file))
  .filter((d, i, all) => all.findIndex((x) => x.file === d.file) === i)   // one anchor per file
  .slice(0, maxAnchors);

const tsModel = (query: string, center: string): any => {
  const out = `/tmp/parity-${query}-${process.pid}.json`;
  try {
    execFileSync("bun", [CLI, "--scan", "--repo", repo, "--query", query, "--center", center, "--emit-seams", out],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
    const m = JSON.parse(readFileSync(out, "utf-8"));
    unlinkSync(out);
    return m;
  } catch (e) { return { __error: String(e).slice(0, 200) }; }
};

const serWriters = (m: any, rust: boolean) => {
  const fc = rust ? (m.filterColumns ?? []).map((r: string[]) => `${r[0]}=${r.slice(1).join(",")}`)
                  : Object.entries(m.filterColumns ?? {}).sort().map(([t, c]: any) => `${t}=${c.join(",")}`);
  return [
    `shape=${m.shape} tables=${(m.tables ?? []).join(",")} colGrain=${m.columnGrain ?? m.column_grain}`,
    `noStructure=${m.noStructure ?? false} reason=${m.reason ?? ""}`,
    `filterColumns=${fc.join("|")}`,
    ...(m.members ?? []).map((x: any) =>
      `${x.table}|${x.file}|${x.line}|${x.symbol}|${x.kind}|${x.edgeKind ?? x.edge_kind}|${x.provenance}|${(x.columns ?? []).join(",")}|${x.colVerified ?? x.col_verified}`),
  ].join("\n");
};

const serCoupling = (m: any) => [
  `shape=${m.shape} total=${m.total ?? 0} noStructure=${m.noStructure ?? false} reason=${m.reason ?? ""}`,
  ...(m.keys ?? []).flatMap((k: any) => [
    `KEY ${k.kind}|${k.value}|${k.anchorRole ?? k.anchor_role}|${k.sides.length}`,
    ...k.sides.map((s: any) => `  ${s.role}|${s.file}|${s.line}|${s.symbol}|${s.kind}|${(s.columns ?? []).join(",")}`),
  ]),
].join("\n");

let ok = 0, bad = 0, nonTrivial = 0, colGrainAnchors = 0;
const fails: string[] = [];
const t0 = Date.now();

for (const [i, d] of anchors.entries()) {
  const center = `${d.file}#${d.name}`;
  const cmp = (tag: string, a: string, b: string) => {
    if (a === b) { ok++; return; }
    bad++;
    if (fails.length < 6) {
      const al = a.split("\n"), bl = b.split("\n");
      const k = al.findIndex((l, j) => l !== bl[j]);
      fails.push(`✗ ${tag} ${center}\n  ts  [${al.length}]: ${al[k] ?? "<none>"}\n  rust[${bl.length}]: ${bl[k] ?? "<none>"}`);
    }
  };
  const tw = tsModel("writers", center);
  const rw = addon.projectWriters(repo, d.file, d.name);
  const tc = tsModel("coupling", center);
  const rc = addon.projectCoupling(repo, d.file, d.name);
  if ((tw.members ?? []).length || (tc.keys ?? []).length) nonTrivial++;
  // COLUMN-GRAIN coverage. `access_columns` (the reader's `where` keys × each writer's `data` keys) is the
  // subtlest thing ported here, and it only runs when the reader HAS parseable filter columns. Counted and
  // reported so a sample that never reaches it cannot read as if it verified it.
  if (Object.keys(tw.filterColumns ?? {}).length) colGrainAnchors++;
  cmp("writers", serWriters(tw, false), serWriters(rw, true));
  cmp("coupling", serCoupling(tc), serCoupling(rc));
  process.stderr.write(`\r[${i + 1}/${anchors.length} ${Math.round((Date.now() - t0) / 1000)}s ok=${ok} bad=${bad}]`);
}

process.stderr.write("\n");
console.log(`\nwriters/coupling parity over ${repo}`);
console.log(`  anchors: ${anchors.length}   with members or keys: ${nonTrivial}`);
console.log(`  byte-identical: ${ok}   mismatches: ${bad}`);
console.log(`  anchors exercising COLUMN grain: ${colGrainAnchors}${colGrainAnchors ? "" : "  (none — the column intersection was NOT covered by this sample)"}`);
for (const f of fails) console.log(f);
if (!nonTrivial) { console.log("  REFUSING to pass: every anchor was empty — this proved nothing."); process.exit(2); }
process.exit(bad ? 1 : 0);
