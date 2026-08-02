// The `.seam/` cache directory lives at the base (core) layer because EVERY writer touches it — the
// deterministic floor's incremental index (core/resolve), the graph-cache shards, the footprint cache
// (scan/), and the coupling adapter/key stores. On first write we drop a self-ignoring `.gitignore` so the
// lazy/solo cache never pollutes the analyzed repo's git status by default. The CI WARM-UP path commits it
// deliberately (`git add -f .seam/…`) — that explicit override is the signal that the team wants the
// LLM-deduced adapters shared (then every `det` run inherits them, offline).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SEAM_DIR = ".seam";

// THE CACHE ROOT for `repo` — `<repo>/.seam` by default, or `$SEAM_REPO_CACHE_DIR/<slug>` when set.
//
// NAMED `SEAM_REPO_CACHE_DIR`, NOT `SEAM_CACHE_DIR` — that name is already taken by the DIFF cache
// (`seam_env.ts`, `~/.cache/seam/diff`), and `test/core/cache.test.ts` sets it process-globally. Reusing it
// redirected every later test's REPO cache into the diff cache and broke 24 tests, because `syncSeamEnv`
// forwards every `SEAM_*` var into the core. A collision between two live flags fails silently, at a distance.
//
// WHY IT IS OVERRIDABLE (bench/grep-vs-seam, 2026-08-02). Every shard cache lives under the REPO being
// analysed, so two processes reading the same checkout share one cache whether they mean to or not. That is
// the point when it makes a run warm, and a hazard when it does not: a benchmark and a profiling run against
// the same repo contend, and clearing the cache for one silently re-times the other. That happened —
// deleting `grow-v1` to set up a measurement invalidated two of three in-flight benchmark runs — and a git
// worktree does NOT help, because it isolates the code, not the repo under test.
//
// THE SLUG MUST MATCH `seam_fs::seam_dir` IN RUST, CHARACTER FOR CHARACTER. The two engines write into the
// same tree (the Rust core owns the shards, this side owns the import-index and footprint caches), so a
// disagreement about the root would not error — it would silently split the cache in half and each side
// would quietly miss what the other wrote. Same rule both sides: non-alphanumeric → `_`, then trim `_`.
export function seamRoot(repo: string): string {
  const override = process.env.SEAM_REPO_CACHE_DIR;
  if (!override || !override.trim()) return join(repo, SEAM_DIR);
  const slug = repo.replace(/\\/g, "/").replace(/[^A-Za-z0-9]/g, "_").replace(/^_+|_+$/g, "");
  return join(override.trim().replace(/\/+$/, ""), slug);
}

// Drop the self-ignoring `.gitignore` if it isn't there yet. Idempotent and best-effort (a read-only repo
// just skips it — the cache already degrades to in-memory).
export function ensureSeamGitignore(repo: string): void {
  const gi = join(seamRoot(repo), ".gitignore");
  try {
    if (existsSync(gi)) return;
    mkdirSync(seamRoot(repo), { recursive: true });
    writeFileSync(gi, "# Seam cache — auto-generated, deterministic-after-first-run.\n# Self-ignored by default; `git add -f .seam/*.json` to commit a CI warm-up for the team.\n*\n");
  } catch { /* read-only repo → no-op (the cache itself already degrades to in-memory) */ }
}

// mkdir `.seam/` AND drop the self-ignoring `.gitignore` in one shot — the single entry point every writer
// uses instead of a bare `mkdirSync(join(repo, ".seam"))`, so the cache can NEVER be created without its
// ignore rule. Returns the absolute dir path. Best-effort: a read-only repo yields the path but no dir.
export function ensureSeamDir(repo: string): string {
  const dir = seamRoot(repo);
  try { mkdirSync(dir, { recursive: true }); ensureSeamGitignore(repo); } catch { /* read-only → in-memory only */ }
  return dir;
}
