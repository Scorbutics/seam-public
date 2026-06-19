// The `.seam/` cache directory (carrier signatures + key adapters). On first write we drop a self-ignoring
// `.gitignore` so the lazy/solo cache never pollutes the analyzed repo's git status by default. The CI
// WARM-UP path commits it deliberately (`git add -f .seam/…`) — that explicit override is the signal that
// the team wants the LLM-deduced adapters shared (then every `det` run inherits them, offline).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SEAM_DIR = ".seam";

// The SHARED, cross-repo adapter store — your "common" promoted adapters. Caches read repo-local FIRST,
// then here; `seam-adapters promote` copies a learned adapter up into it for review. Default
// `~/.config/seam/adapters` (NOT `~/.seam` — that's install.sh's checkout dir, and NOT $SEAM_HOME — that's
// install.sh's checkout-dir override). Override the adapter store with $SEAM_ADAPTERS_DIR.
export function sharedSeamDir(): string {
  const env = process.env.SEAM_ADAPTERS_DIR;
  return env && env.trim() ? env : join(homedir(), ".config", "seam", "adapters");
}

export function ensureSeamGitignore(repo: string): void {
  const gi = join(repo, SEAM_DIR, ".gitignore");
  try {
    if (existsSync(gi)) return;
    mkdirSync(dirname(gi), { recursive: true });
    writeFileSync(gi, "# Seam cache — auto-generated, deterministic-after-first-run.\n# Self-ignored by default; `git add -f .seam/*.json` to commit a CI warm-up for the team.\n*\n");
  } catch { /* read-only repo → no-op (the cache itself already degrades to in-memory) */ }
}
