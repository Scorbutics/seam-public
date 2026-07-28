// GREP — the one primitive the LLM flywheel still needs from the old targeted-coupling bridge: "which files
// mention this literal?". The bridge itself (the targeted value-grep pipeline that answered "what is on the
// other side of this anchor's keys?") is the core's now — `seam_couple::coupling_other_sides` — and so is the
// full-repo GROUND/DRAW/WIRE walk that used to live next to it in index.ts.
import { spawnSync } from "node:child_process";
import { SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { walkFiles } from "../../core/resolve/walk.js";
import { scannableForKeys } from "./core_floor.js";

// Files containing `value` literally — ripgrep (gitignore-aware, instant) with a walk+substring fallback. The
// value is a plausible key (identifier/path), matched as a FIXED string, so there's no regex/shell hazard.
//
// TOTALLY ORDERED (path ascending) — NOT a ranking, a DETERMINISM contract. `rg -l` walks the tree on a THREAD
// POOL, so its emission order is a RACE: the same repo + same value yields a different permutation every run.
// Every caller then CAPS the list (the targeted candidate cap, files-per-class), which turned a bounded scan
// into a LOTTERY — a different subset survived the cap each run, so the SAME query answered differently
// (measured on cal.com: `getBusyTimes` reported 1..6 cross-stack crossings across identical cold runs, each run's
// set a different prefix of a different permutation). The result is a SET semantically, so normalise it to its
// canonical order in ONE place and every caller's budget becomes order-independent. Same set, fixed order — no
// re-ranking, no recall trade. (The walk fallback is already ordered — walk.ts sorts readdir.)
export function grepFiles(repo: string, value: string): string[] {
  try {
    const r = spawnSync("rg", ["-l", "-F", "--no-messages", "--", value, "."], { cwd: repo, encoding: "utf-8", maxBuffer: 1 << 27 });
    if (r.status === 0 && r.stdout) return r.stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, "")).sort();
    if (r.status === 1) return [];   // ripgrep ran, no matches
  } catch { /* rg absent → fallback */ }
  const out: string[] = [];          // fallback: read+includes (no masking/adapters → far cheaper than the floor scan)
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, scannableForKeys)) if (text.includes(value)) out.push(rel);
  return out.sort();
}
