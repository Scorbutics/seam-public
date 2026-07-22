// Characterize files_index+apply_matchers vs TS llmKeyIndex — residual should be exactly composed-routes keys.
import { createRequire } from "node:module";
import { llmKeyIndex } from "../../ts/src/codebase/coupling/llm_key_index.js";
import { composeRoutes } from "../../ts/src/codebase/coupling/route_composer.js";
import { module_scope } from "../../ts/src/core/resolve/languages/index.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const anchor = process.argv[3] ?? "services/src/main/java/org/keycloak/services/resources/admin/UsersResource.java";
const scope = module_scope(repo, anchor);
const ts = await llmKeyIndex(repo, {scope, scopeFiles: undefined, llm:false}, new EngineCtx());
const tsRows: string[] = [];
for (const [k,s] of ts){ for(const a of s.producers) tsRows.push(`${k}|p|${a.file}|${a.line}`); for(const a of s.consumers) tsRows.push(`${k}|c|${a.file}|${a.line}`);}
const rust = new Set(addon.keyIndexNoCompose(repo, anchor) as string[]);
const tsSet = new Set(tsRows);
const composed = await composeRoutes(repo, {llm:false}, new EngineCtx());
const composedKeys = new Set([...composed.keys()]);
const tsOnly = tsRows.filter(r=>!rust.has(r));
const rustOnly = [...rust].filter(r=>!tsSet.has(r));
// how many ts-only rows belong to a composed key?
const tsOnlyComposed = tsOnly.filter(r=>composedKeys.has(r.split("|")[0]));
console.log(`\nkey_index (files⊕matchers) vs TS llmKeyIndex @ ${anchor.split("/").pop()}`);
console.log(`  ts rows ${tsRows.length}, rust rows ${rust.size}, composed keys ${composedKeys.size}`);
console.log(`  ts-only ${tsOnly.length} (of which composed-key: ${tsOnlyComposed.length}), rust-only ${rustOnly.length}`);
if(rustOnly.length) console.log("  rust-only sample:", rustOnly.slice(0,8));
const nonComposedTsOnly = tsOnly.filter(r=>!composedKeys.has(r.split("|")[0]));
if(nonComposedTsOnly.length) console.log("  ts-only NON-composed (files/matcher bug?):", nonComposedTsOnly.slice(0,10));
else console.log("  ✓ all ts-only rows are composed-route keys — files_index + apply_matchers exact");
