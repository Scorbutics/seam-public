// Byte-identical harness — Rust key_index (files ⊕ matchers ⊕ composed) vs TS llmKeyIndex (llm-off).
import { createRequire } from "node:module";
import { llmKeyIndex } from "../../ts/src/codebase/coupling/llm_key_index.js";
import { module_scope } from "../../ts/src/core/resolve/languages/index.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const anchors = process.argv.slice(3);
if (!anchors.length) anchors.push(
  "services/src/main/java/org/keycloak/services/resources/admin/UsersResource.java",
  "core/src/main/java/org/keycloak/representations/idm/authorization/UmaPermissionRepresentation.java",
  "federation/ldap/src/main/java/org/keycloak/storage/ldap/LDAPStorageProvider.java",
);
let allOk = true;
for (const anchor of anchors) {
  const scope = module_scope(repo, anchor);
  const ts = await llmKeyIndex(repo, { scope, scopeFiles: undefined, llm: false }, new EngineCtx());
  const tsRows: string[] = [];
  for (const [k, s] of ts) { for (const a of s.producers) tsRows.push(`${k}|p|${a.file}|${a.line}`); for (const a of s.consumers) tsRows.push(`${k}|c|${a.file}|${a.line}`); }
  const rust = addon.keyIndex(repo, anchor) as string[];
  let bad = 0; const fails: string[] = [];
  for (let i = 0; i < Math.max(tsRows.length, rust.length); i++) if (tsRows[i] !== rust[i]) { bad++; if (fails.length < 8) fails.push(`  [${i}] ts=${tsRows[i] ?? "-"}  rust=${rust[i] ?? "-"}`); }
  console.log(`@ ${anchor.split("/").pop()} (scope ${JSON.stringify(scope)}): ts ${tsRows.length}, rust ${rust.length} — ${bad ? `MISMATCH ${bad}` : "byte-identical OK"}`);
  if (fails.length) { console.log(fails.join("\n")); allOk = false; }
}
process.exit(allOk ? 0 : 1);
