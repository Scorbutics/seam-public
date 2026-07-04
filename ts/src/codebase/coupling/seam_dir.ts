// The `.seam/` cache directory (carrier signatures + key adapters). The generic dir constant + self-ignoring
// `.gitignore` helper live in core (every layer writes the cache); re-exported here so coupling's existing
// importers are unchanged. This module adds only the coupling-specific SHARED adapter store.
import { homedir } from "node:os";
import { join } from "node:path";

export { SEAM_DIR, ensureSeamGitignore, ensureSeamDir } from "../../core/seam_dir.js";

// The SHARED, cross-repo adapter store — your "common" promoted adapters. Caches read repo-local FIRST,
// then here; `seam-adapters promote` copies a learned adapter up into it for review. Default
// `~/.config/seam/adapters` (NOT `~/.seam` — that's install.sh's checkout dir, and NOT $SEAM_HOME — that's
// install.sh's checkout-dir override). Override the adapter store with $SEAM_ADAPTERS_DIR.
export function sharedSeamDir(): string {
  const env = process.env.SEAM_ADAPTERS_DIR;
  return env && env.trim() ? env : join(homedir(), ".config", "seam", "adapters");
}
