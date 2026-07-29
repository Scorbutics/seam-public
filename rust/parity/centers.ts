// DIFFERENTIAL: Rust `seam_grow::center::detect_centers` vs the TypeScript oracle.
//
// Center detection decides WHICH mechanism a concern is rendered around, so a drift here changes the whole
// answer rather than a detail of it. Compared over real footprints, in both modes that matter:
//
//   NO RELEVANCE   — the degradation path (no embeddings / nothing on-intent): raw fan-in, single center.
//   WITH RELEVANCE — the real path: log-fan x relevance x proximity, top-K.
//
// The relevance map is SYNTHESISED deterministically rather than embedded. Real embeddings would make the
// comparison depend on a model's float output on two sides of a boundary — the thing that already put a
// noise floor under the intent-grow work. A synthetic map exercises the same branches (floor, ordering,
// tie-breaks) and is reproducible.
//
//   bun rust/parity/centers.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCenters } from "../../ts/src/codebase/grow/center.js";
import { loadAddon, toResolvedGraph } from "../../ts/src/codebase/rust_core.js";

const addon = loadAddon();
if (!addon) { console.log("no addon"); process.exit(0); }

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "..", "..");
const fixtures = join(REPO, "ts", "test", "fixtures");

// ---- corpus: real footprints -----------------------------------------------------------------------------
const build = (fn: string, ...args: any[]) => { try { return (addon as any)[fn](...args); } catch { return null; } };
const graphs: { name: string; g: any }[] = [];
for (const f of readdirSync(fixtures).filter((f) => f.endsWith("-graph.json")))
  graphs.push({ name: f, g: JSON.parse(readFileSync(join(fixtures, f), "utf-8")) });
const targets: [string, string, string][] = [];
for (const d of readdirSync(fixtures).filter((d) => d.endsWith("-repo") || d === "booking-app")) {
  const repo = join(fixtures, d);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (["node_modules", ".git", ".seam"].includes(e.name) ? [] : walk(join(dir, e.name)))
      : /\.(ts|tsx|js|java|rb|py|go)$/.test(e.name) ? [join(dir, e.name).slice(repo.length + 1)] : []);
  for (const rel of walk(repo).slice(0, 10))
    for (const def of ((build("defsInFile", rel, readFileSync(join(repo, rel), "utf-8")) ?? []) as any[]).slice(0, 4))
      targets.push([repo, rel, def.name]);
}
for (const [repo, rel, sym] of targets) {
  for (const dc of [false, true]) {
    const dto = build("buildConsumersGraph", repo, rel, sym, null, dc);
    if (!dto) continue;
    let g: any; try { g = toResolvedGraph(dto); } catch { continue; }
    if ((g?.nodes?.length ?? 0) > 2) graphs.push({ name: `${rel}:${sym}${dc ? ":dc" : ""}`, g });
  }
}

// A deterministic stand-in for the embedding field: a stable hash of "symbol file" into [0,1). Exercises the
// floor and the ordering without importing a model's float behaviour into a cross-engine comparison.
const relOf = (symbol: string, file: string): number => {
  let h = 2166136261;
  for (const ch of `${symbol} ${file}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h % 1000) / 1000;
};

let ok = 0, bad = 0, withRel = 0, degraded = 0, multi = 0;
const fails: string[] = [];
const norm = (cs: any[]) => JSON.stringify(cs.map((c) => [c.id, c.file, c.symbol, c.fanIn ?? c.fan_in]));

for (const { name, g } of graphs) {
  const anchorId = g.anchor?.id ?? g.nodes?.[0]?.id;
  for (const mode of ["no-relevance", "with-relevance"] as const) {
    // minFanIn is varied because the DEFAULT (2) leaves the top-K path almost unexercised on small
    // footprints — measured, exactly ONE graph produced more than one center. At 1 the candidate set is wide
    // enough that the ranking, the floor and the tie-breaks actually decide something.
    for (const [k, minFan] of [[1, 2], [4, 2], [4, 1], [8, 1]] as [number, number][]) {
      const relevance = mode === "with-relevance"
        ? (n: { symbol: string; file: string }) => relOf(n.symbol, n.file)
        : undefined;
      const ts = detectCenters(g, { relevance, anchorId, minFanIn: minFan }, k);

      const rows = mode === "with-relevance"
        ? (g.nodes ?? []).map((n: any) => [`${n.symbol} ${n.file}`, String(relOf(n.symbol, n.file))])
        : [];
      const rs = JSON.parse(addon.growDetectCenters(JSON.stringify(g), rows, k, minFan, undefined, undefined, undefined, anchorId));

      if (ts.length > 1) multi++;
      if (mode === "with-relevance") withRel++; else degraded++;
      if (norm(ts) === norm(rs)) ok++;
      else { bad++; if (fails.length < 5) fails.push(`${name} [${mode} k=${k}]\n  TS: ${norm(ts).slice(0, 300)}\n  RS: ${norm(rs).slice(0, 300)}`); }
    }
  }
}
console.log(`centers parity: ${ok} ok / ${bad} bad   (graphs ${graphs.length}, with-relevance ${withRel}, degraded ${degraded}, multi-center results ${multi})`);
for (const x of fails) console.log("  " + x);
if (bad) process.exit(1);
