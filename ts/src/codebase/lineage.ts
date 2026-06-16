// GIT LINEAGE — the "why" layer, scoped to the footprint (not a whole-repo index). For each seam's
// representative file, the commit that last touched it: SHA + subject (the human INTENT behind the
// code) + author + date. This is the multi-source context dimension Augment's context engine touts
// (commit history), but SCOPED to the intent footprint and 100% DETERMINISTIC — git is ground truth,
// no LLM, no variance. An LLM consumer reads "this seam was last changed by 3e43d16 'feat: edit
// referral members'" as provenance it can trust, not a retrieval guess.
import { spawnSync } from "node:child_process";

const expanduser = (p: string) => (p.startsWith("~") ? (process.env.HOME ?? "") + p.slice(1) : p);

export interface Lineage { sha: string; subject: string; author: string; date: string; }

// One `git log -1` per unique file, scoped to the repo. Returns a file→lineage map; a file git can't
// resolve (untracked / not a git repo / git absent) is simply absent — the caller emits nothing for it,
// so a non-repo (the oracle fixtures) degrades cleanly to no lineage.
export function git_lineage(repo: string, files: string[]): Map<string, Lineage> {
  const out = new Map<string, Lineage>();
  const cwd = expanduser(repo);
  for (const file of [...new Set(files)].filter(Boolean)) {
    let r;
    try {
      r = spawnSync("git", ["-C", cwd, "log", "-1", "--no-color", "--format=%h%x1f%s%x1f%an%x1f%as", "--", file],
        { encoding: "utf-8", timeout: 5000 });
    } catch { continue; }
    if (!r || r.status !== 0) continue;
    const line = (r.stdout ?? "").split("\n")[0];
    if (!line) continue;
    const [sha, subject, author, date] = line.split("\x1f");
    if (sha && subject) out.set(file, { sha, subject, author: author ?? "", date: date ?? "" });
  }
  return out;
}
