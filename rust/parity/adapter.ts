// Byte-identical harness — a Rust coupling adapter vs its TS scan, over Keycloak. Generic:
//   bun rust/parity/adapter.ts <adapterName> [repo] [maxFiles] [glob]
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { makeMaskCtx } from "../../ts/src/codebase/coupling/adapters/util.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");

const name = process.argv[2];
const repo = process.argv[3] ?? "/home/scorbutics/dev/keycloak";
const maxFiles = parseInt(process.argv[4] ?? "3000", 10);
const glob = (process.argv[5] ?? "*.java *.ts *.tsx").split(" ");

// map adapter name → its TS export
const mods: Record<string, () => Promise<any>> = {
  "raw-sql": async () => (await import("../../ts/src/codebase/coupling/adapters/raw_sql.js")).RAW_SQL,
  "jpa-entity": async () => (await import("../../ts/src/codebase/coupling/adapters/jpa_entity.js")).JPA_ENTITY,
  "http-route": async () => (await import("../../ts/src/codebase/coupling/adapters/http_route.js")).HTTP_ROUTE,
  "http-egress": async () => (await import("../../ts/src/codebase/coupling/adapters/http_egress.js")).HTTP_EGRESS,
  "annotation-route": async () => (await import("../../ts/src/codebase/coupling/adapters/annotation_route.js")).ANNOTATION_ROUTE_ADAPTER,
  "member-access": async () => (await import("../../ts/src/codebase/coupling/adapters/member_access.js")).MEMBER_ACCESS,
  "active-record": async () => (await import("../../ts/src/codebase/coupling/adapters/active_record.js")).ACTIVE_RECORD,
  "jooq": async () => (await import("../../ts/src/codebase/coupling/adapters/jooq.js")).JOOQ,
  "endpoint-map": async () => (await import("../../ts/src/codebase/coupling/adapters/endpoint_map.js")).ENDPOINT_MAP,
  "file-channel": async () => (await import("../../ts/src/codebase/coupling/adapters/file_channel.js")).FILE_CHANNEL,
};
const adapter = await mods[name]();
if (!adapter) throw new Error(`unknown adapter ${name}`);

const files = execFileSync("bash", ["-c", `cd ${repo} && git ls-files ${glob.map((g) => `'${g}'`).join(" ")} | grep -v '\\.d\\.ts$' | head -${maxFiles}`]).toString().split("\n").filter(Boolean);
const ser = (hits: any[]) => hits.map((h) => `${h.kind}|${h.value}|${h.line}|${h.produces}|${h.op ?? ""}|${h.label ?? ""}|${h.method ?? ""}|${h.recv ?? ""}`).join(";");
const serR = (rows: string[][]) => rows.map((r) => r.join("|")).join(";");
let ok = 0, bad = 0, nonEmpty = 0, ascii = 0;
const fails: string[] = [];
for (const rel of files) {
  let text: string; try { text = readFileSync(`${repo}/${rel}`, "utf8"); } catch { continue; }
  if (!/^[\x00-\x7F]*$/.test(text)) continue;
  ascii++;
  const ts = adapter.scan(rel, text, makeMaskCtx(text));
  const rust = addon.adapterKeys(name, rel, text) as string[][];
  if (ts.length) nonEmpty++;
  // rust rows are [kind,value,line,produces,op]; TS may carry more fields — compare the 5 rust emits
  const tsS = ts.map((h: any) => `${h.kind}|${h.value}|${h.line}|${h.produces}|${h.op ?? ""}|${h.label ?? ""}|${h.method ?? ""}|${h.recv ?? ""}`).join(";");
  const rS = rust.map((r) => r.join("|")).join(";");
  if (tsS === rS) ok++; else { bad++; if (fails.length < 10) fails.push(`✗ ${rel}\n    ts:   ${tsS}\n    rust: ${rS}`); }
}
console.log(`\n${name} adapter parity over ${repo}  (ascii: ${ascii})`);
console.log(`  ${ok} ok / ${bad} bad   (non-empty: ${nonEmpty})`);
if (fails.length) console.log("\n" + fails.join("\n"));
process.exit(bad ? 1 : 0);
