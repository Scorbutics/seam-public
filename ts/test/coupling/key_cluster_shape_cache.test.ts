// REGRESSION: clusterBlindFiles' tree-sitter shape scan re-parsed EVERY floor-blind file on EVERY separate
// CLI process invocation, even when nothing on disk changed — because the only persisted cache for these
// files (key_store.ts's per-file key-adapters entries) is written by the CALLER, and only when the LLM/
// matcher pass actually ran; in `--data-coupling floor` mode it never does, so the same files were re-
// clustered from scratch on every "warm" run (measured on Keycloak: ~2m unchanged across two back-to-back
// runs). Fixed by a separate, purely-structural content-hash-keyed disk cache for the shape scan itself
// (`.seam/shape-scan-v1/`) — safe to persist regardless of LLM mode since it never claims a matcher rule
// grounds the file, just that "this content's shape tokens are X".
//
// Proven here by SEEDING the cache with a deliberately WRONG signature and confirming clusterBlindFiles
// returns the seeded (wrong) value instead of recomputing the true one — the only way to demonstrate a read
// actually came from the cache rather than a fresh (and coincidentally identical) parse.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clusterBlindFiles } from "../../src/codebase/coupling/key_cluster.js";
import { available } from "../../src/codebase/atoms.js";
import { saveShard, loadShard } from "../../src/core/resolve/index_cache.js";

const repo = join(tmpdir(), "seam-key-cluster-shape-cache-" + process.pid);
beforeAll(() => mkdirSync(repo, { recursive: true }));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("clusterBlindFiles — persistent shape-scan cache (repo param)", () => {
  test("a repo-scoped call persists the shape scan, and a later call reads it back instead of re-parsing", async () => {
    if (!available()) return;
    const f = { file: "a.ts", text: `export async function a() { return prisma.eventType.findMany(); }` };
    const clusters = await clusterBlindFiles([f], repo);
    expect(clusters[0].signature).toBe("recv:prisma");

    // seed a WRONG signature under the exact content-hash key this file would produce, then confirm the
    // wrong value comes back — proving the second call is a cache READ, not a fresh parse.
    const { createHash } = await import("node:crypto");
    const ck = `${f.file} ${createHash("sha1").update(f.text).digest("hex")}`;
    expect(loadShard(repo, "shape-scan-v1", ck)).toBeDefined();   // the first call actually wrote a shard
    saveShard(repo, "shape-scan-v1", ck, { tokens: ["recv:SEEDED"], weak: [], hasSignal: true });

    const clusters2 = await clusterBlindFiles([f], repo);
    expect(clusters2[0].signature).toBe("recv:SEEDED");
  });

  test("without a repo param, no disk cache is touched (in-memory callers/tests are unaffected)", async () => {
    if (!available()) return;
    const f = { file: "b.ts", text: `export async function b() { return prisma.user.update({}); }` };
    const clusters = await clusterBlindFiles([f]);
    expect(clusters[0].signature).toBe("recv:prisma");
    const { createHash } = await import("node:crypto");
    const ck = `${f.file} ${createHash("sha1").update(f.text).digest("hex")}`;
    expect(loadShard(repo, "shape-scan-v1", ck)).toBeUndefined();
  });
});
