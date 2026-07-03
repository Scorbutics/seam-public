// SHARDED per-file cache (docs/GRAPH_CACHE.md, Phase 1) — the partial-invalidation contract the graph cache
// rides on: a one-file edit re-scans ONLY that file's shard; a delete drops ONLY its shard; a config-salt
// change rebuilds all; and loadShard hydrates one file WITHOUT touching the manifest or its neighbours.
// Hermetic: a throwaway tmp repo built in beforeEach, removed in afterEach. No embeddings/tree-sitter needed.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shardedIncrementalScanAsync, loadShard } from "../../src/core/resolve/index_cache.js";

const SKIP = new Set<string>(["node_modules", ".seam"]);
const isTs = (rel: string) => rel.endsWith(".ts");

let repo: string;
// scanFile records which files it actually READ this pass — the behavioural proof of "only re-scan the change".
let scanned: string[] = [];
const scan = async (rel: string, text: string) => { scanned.push(rel); return { rel, len: text.length }; };
const run = () => { scanned = []; return shardedIncrementalScanAsync(repo, SKIP, isTs, "salt-1", scan, "graph-test"); };
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

beforeEach(() => {
  repo = join(tmpdir(), "seam-sharded-" + process.pid + "-" + Math.round(process.hrtime()[1]));
  mkdirSync(repo, { recursive: true });
  w("a.ts", "export const a = 1;\n");
  w("b.ts", "export const b = 2;\n");
  w("sub/c.ts", "export const c = 3;\n");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("shardedIncrementalScanAsync — partial invalidation", () => {
  test("cold run scans every file and writes one shard each + a manifest", async () => {
    const out = await run();
    expect(out.map((o) => o.rel).sort()).toEqual(["a.ts", "b.ts", "sub/c.ts"]);
    expect(scanned.sort()).toEqual(["a.ts", "b.ts", "sub/c.ts"]);   // all scanned cold
    expect(existsSync(join(repo, ".seam/graph-test/manifest.json"))).toBe(true);
    expect(readdirSync(join(repo, ".seam/graph-test/f")).length).toBe(3);   // one shard per file
  });

  test("warm run with NO changes re-scans nothing (all shards reused)", async () => {
    await run();
    const out2 = await run();
    expect(scanned).toEqual([]);                                   // ← the payoff: zero re-scan
    expect(out2.map((o) => o.rel).sort()).toEqual(["a.ts", "b.ts", "sub/c.ts"]);
  });

  test("editing ONE file re-scans only that file; the others stay reused", async () => {
    await run();
    // bump mtime AND content so the (m,s) key changes
    w("b.ts", "export const b = 22;\n");
    const t = Date.now() / 1000 + 5; utimesSync(join(repo, "b.ts"), t, t);
    const out = await run();
    expect(scanned).toEqual(["b.ts"]);                             // ← only the edited file
    expect(out.find((o) => o.rel === "b.ts")!.data).toMatchObject({ len: "export const b = 22;\n".length });
  });

  test("deleting a file drops ONLY its shard (prune), leaves the rest", async () => {
    await run();
    expect(readdirSync(join(repo, ".seam/graph-test/f")).length).toBe(3);
    rmSync(join(repo, "sub/c.ts"));
    const out = await run();
    expect(scanned).toEqual([]);                                   // surviving files reused, not re-scanned
    expect(out.map((o) => o.rel).sort()).toEqual(["a.ts", "b.ts"]);
    expect(readdirSync(join(repo, ".seam/graph-test/f")).length).toBe(2);   // c.ts's shard pruned
  });

  test("a config-salt change rebuilds every shard (cache only affects speed, never output)", async () => {
    await run();
    scanned = [];
    const out = await shardedIncrementalScanAsync(repo, SKIP, isTs, "salt-2", scan, "graph-test");   // new salt
    expect(scanned.sort()).toEqual(["a.ts", "b.ts", "sub/c.ts"]);   // all re-scanned under the new salt
    expect(out.length).toBe(3);
  });

  test("loadShard hydrates ONE file's contribution directly, without the manifest", async () => {
    await run();
    expect(loadShard(repo, "graph-test", "a.ts")).toMatchObject({ rel: "a.ts", len: "export const a = 1;\n".length });
    expect(loadShard(repo, "graph-test", "sub/c.ts")).toMatchObject({ rel: "sub/c.ts" });
    expect(loadShard(repo, "graph-test", "does/not/exist.ts")).toBeUndefined();   // cold miss
  });
});
