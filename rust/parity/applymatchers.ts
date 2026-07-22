// Byte-identical harness — Rust apply_matchers vs TS applyMatchers (repo-wide matcher grounding) over Keycloak.
import { createRequire } from "node:module";
import { applyMatchers } from "../../ts/src/codebase/coupling/key_matcher.js";
import { loadMatchers } from "../../ts/src/codebase/coupling/key_store.js";
const require = createRequire(import.meta.url);
const addon = require("/home/scorbutics/seam-phase0/rust/seam_core.node");
const repo = process.argv[2] ?? "/home/scorbutics/dev/keycloak";
const matchers = loadMatchers(repo);
const idx = await applyMatchers(repo, matchers);
const tsRows: string[] = [];
for (const [key, sides] of idx) { for (const a of sides.producers) tsRows.push(`${key}|p|${a.file}|${a.line}`); for (const a of sides.consumers) tsRows.push(`${key}|c|${a.file}|${a.line}`); }
const rust = addon.applyMatchers(repo) as string[];
console.log(`\napplyMatchers over ${repo}: ts rows ${tsRows.length}, rust rows ${rust.length}, keys ${idx.size}`);
let bad=0; const fails:string[]=[];
for(let i=0;i<Math.max(tsRows.length,rust.length);i++) if(tsRows[i]!==rust[i]){bad++;if(fails.length<15)fails.push(`  [${i}] ts=${tsRows[i]??"-"}  rust=${rust[i]??"-"}`);}
console.log(bad?`\n  MISMATCH ${bad} rows`:`\n  byte-identical ✓ (${tsRows.length} rows)`);
if(fails.length)console.log(fails.join("\n"));
process.exit(bad?1:0);
