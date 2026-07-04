// The `.seam/` cache directory lives at the base (core) layer because EVERY writer touches it — the
// deterministic floor's incremental index (core/resolve), the graph-cache shards, the footprint cache
// (scan/), and the coupling adapter/key stores. On first write we drop a self-ignoring `.gitignore` so the
// lazy/solo cache never pollutes the analyzed repo's git status by default. The CI WARM-UP path commits it
// deliberately (`git add -f .seam/…`) — that explicit override is the signal that the team wants the
// LLM-deduced adapters shared (then every `det` run inherits them, offline).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SEAM_DIR = ".seam";

// Drop the self-ignoring `.gitignore` if it isn't there yet. Idempotent and best-effort (a read-only repo
// just skips it — the cache already degrades to in-memory).
export function ensureSeamGitignore(repo: string): void {
  const gi = join(repo, SEAM_DIR, ".gitignore");
  try {
    if (existsSync(gi)) return;
    mkdirSync(join(repo, SEAM_DIR), { recursive: true });
    writeFileSync(gi, "# Seam cache — auto-generated, deterministic-after-first-run.\n# Self-ignored by default; `git add -f .seam/*.json` to commit a CI warm-up for the team.\n*\n");
  } catch { /* read-only repo → no-op (the cache itself already degrades to in-memory) */ }
}

// mkdir `.seam/` AND drop the self-ignoring `.gitignore` in one shot — the single entry point every writer
// uses instead of a bare `mkdirSync(join(repo, ".seam"))`, so the cache can NEVER be created without its
// ignore rule. Returns the absolute dir path. Best-effort: a read-only repo yields the path but no dir.
export function ensureSeamDir(repo: string): string {
  const dir = join(repo, SEAM_DIR);
  try { mkdirSync(dir, { recursive: true }); ensureSeamGitignore(repo); } catch { /* read-only → in-memory only */ }
  return dir;
}
