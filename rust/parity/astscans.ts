// PHASE 1 byte-identical harness — the receiver-resolution + attribution AST scans build_callsite_graph uses.
// Rust call_sites / named_units / instance_types / type_names vs their TS originals, over Java files.
//   bun rust/parity/astscans.ts [repo] [maxFiles]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeCtx, available } from "../../ts/src/codebase/atoms.js";
import { _method_call_sites, _instance_types, _type_names } from "../../ts/src/codebase/scan/ast_class.js";
import { _named_units } from "../../ts/src/codebase/scan/ast_units.js";

const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[3] ?? "2000", 10);
if (!available()) {
  console.log("tree-sitter unavailable — skipped");
  process.exit(0);
}

const files = execFileSync("git", ["-C", repo, "ls-files", "-z", "*.java"], { maxBuffer: 512 * 1024 * 1024 })
  .toString()
  .split("\0")
  .filter(Boolean)
  .slice(0, maxFiles);

const stat = { sites: [0, 0], units: [0, 0], insts: [0, 0], types: [0, 0] };
const fails: string[] = [];
const rec = (k: "sites" | "units" | "insts" | "types", ok: boolean, msg: () => string) => {
  stat[k][ok ? 0 : 1]++;
  if (!ok && fails.length < 8) fails.push(msg());
};

for (const rel of files) {
  let text: string;
  try {
    text = readFileSync(`${repo}/${rel}`, "utf-8");
  } catch {
    continue;
  }
  const ctx = await makeCtx(text, "java");
  if (!ctx) continue;

  // call sites — compare over the method set Rust found (called_method_names is already byte-identical, so the
  // set is complete); TS _method_call_sites filters _all_call_sites by it.
  const rustSites = addon.callSites(text, "java") as any[];
  const methods = new Set<string>(rustSites.map((s) => s.method));
  const tsSites = (_method_call_sites(ctx, methods) as any[]).map((s) => `${s.method}|${s.line}|${s.recvId}|${s.recvNew}`).join("\n");
  const rSites = rustSites.map((s) => `${s.method}|${s.line}|${s.recvId ?? null}|${s.recvNew ?? null}`).join("\n");
  rec("sites", tsSites === rSites, () => `  call_sites ${rel}\n    ts:   ${tsSites.split("\n")[0]}\n    rust: ${rSites.split("\n")[0]}`);

  const tsUnits = (_named_units(ctx) as any[]).map((u) => `${u[0]}|${u[1]}|${u[2]}|${u[3]}`).join("\n");
  const rUnits = (addon.namedUnits(text, "java") as any[]).map((u) => `${u.name}|${u.kind}|${u.start}|${u.end}`).join("\n");
  rec("units", tsUnits === rUnits, () => `  named_units ${rel}\n    ts:   ${tsUnits.split("\n").find((l, i) => l !== rUnits.split("\n")[i]) ?? ""}\n    rust: ${rUnits.split("\n").find((l, i) => l !== tsUnits.split("\n")[i]) ?? ""}`);

  const tsTypes = [...(_type_names(ctx) as Set<string>)].sort().join("\n");
  const rTypes = (addon.typeNames(text, "java") as string[]).join("\n");
  rec("types", tsTypes === rTypes, () => `  type_names ${rel}`);

  const tsInsts = [...(_instance_types(ctx) as Map<string, Set<string>>)].map(([n, s]) => [n, ...[...s].sort()].join(",")).sort().join("\n");
  const rInsts = (addon.instanceTypes(text, "java") as string[][]).map((row) => row.join(",")).sort().join("\n");
  rec("insts", tsInsts === rInsts, () => `  instance_types ${rel}`);
}

const line = (k: string, s: number[]) => `  ${k}: ✅ ${s[0]}  ❌ ${s[1]}`;
console.log(`AST callsite-scan parity over Java files:`);
console.log(line("call_sites    ", stat.sites));
console.log(line("named_units   ", stat.units));
console.log(line("type_names    ", stat.types));
console.log(line("instance_types", stat.insts));
if (fails.length) console.log(fails.join("\n"));
const bad = stat.sites[1] + stat.units[1] + stat.types[1] + stat.insts[1];
process.exit(bad ? 1 : 0);
