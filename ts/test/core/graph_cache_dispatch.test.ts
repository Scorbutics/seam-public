// Graph cache Phase 2 (docs/GRAPH_CACHE.md) — incrementalScanAsync DISPATCHES to the sharded store when
// SEAM_GRAPH_CACHE=1, and the merged result is byte-identical to the monolithic layout. This is the contract
// that lets impl-index / callsite shard for free: same walk+salt+scanFile ⇒ same output, only the disk layout
// differs. Hermetic tmp repo; no embeddings/tree-sitter.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { incrementalScanAsync } from "../../src/core/resolve/index_cache.js";

const SKIP = new Set<string>(["node_modules", ".seam"]);
const isTs = (rel: string) => rel.endsWith(".ts");
const scan = async (rel: string, text: string) => ({ rel, len: text.length });

let repo: string;
beforeEach(() => {
  repo = join(tmpdir(), "seam-gc-dispatch-" + process.pid + "-" + Math.round(process.hrtime()[1]));
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  writeFileSync(join(repo, "sub/c.ts"), "export const c = 3;\n");
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); delete process.env.SEAM_GRAPH_CACHE; });

describe("incrementalScanAsync — graph-cache dispatch", () => {
  test("KILL SWITCH (SEAM_GRAPH_CACHE=0): writes the monolithic <name>.json, not a shard dir", async () => {
    process.env.SEAM_GRAPH_CACHE = "0";
    await incrementalScanAsync(repo, SKIP, isTs, "v1", scan, "idx");
    expect(existsSync(join(repo, ".seam/idx.json"))).toBe(true);
    expect(existsSync(join(repo, ".seam/idx/manifest.json"))).toBe(false);
  });

  test("DEFAULT (env unset) + ON: writes per-file shards + a manifest, not the monolithic JSON", async () => {
    delete process.env.SEAM_GRAPH_CACHE;   // graph cache is now ON by default
    await incrementalScanAsync(repo, SKIP, isTs, "v1", scan, "idx");
    expect(existsSync(join(repo, ".seam/idx/manifest.json"))).toBe(true);
    expect(existsSync(join(repo, ".seam/idx.json"))).toBe(false);
  });

  test("the merged result is IDENTICAL whether sharded or monolithic (only disk layout differs)", async () => {
    process.env.SEAM_GRAPH_CACHE = "0";
    const mono = await incrementalScanAsync(repo, SKIP, isTs, "v1", scan, "idxA");
    process.env.SEAM_GRAPH_CACHE = "1";
    const shard = await incrementalScanAsync(repo, SKIP, isTs, "v1", scan, "idxB");
    const norm = (r: { rel: string; data: any }[]) => r.map((x) => ({ rel: x.rel, data: x.data })).sort((p, q) => p.rel.localeCompare(q.rel));
    expect(norm(shard)).toEqual(norm(mono));   // byte-identical contribution set + order-independent equality
  });
});
