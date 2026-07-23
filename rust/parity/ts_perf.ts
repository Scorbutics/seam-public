// TS-engine grow timing (to compare against the Rust core at the same cache levels).
import { grow_to_terminals } from "../../ts/src/codebase/grow/orchestrate.js";
import { EngineCtx } from "../../ts/src/codebase/engine_ctx.js";
const [, , repo, file, sym] = process.argv;
const ctx = new EngineCtx();
const t0 = performance.now();
const r = await grow_to_terminals(repo, file, sym, { dataCoupling: true, ctx } as any);
const d = Array.isArray(r) ? r[0] : r;
console.log(`TS grow ${sym}: ${((performance.now() - t0) / 1000).toFixed(2)}s nodes=${d?.nodes?.length}`);
