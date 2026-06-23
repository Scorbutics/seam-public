// A repo directory walk that prunes SKIP_DIRS — the shared substrate for the package map and the
// consumer/blast-radius scans (the os.walk equivalent). Entries are sorted so the traversal is
// DETERMINISTIC across machines: raw readdir order varies by OS/filesystem (ext4 vs overlayfs,
// Linux vs macOS), and downstream consumers assign positional graph ids in walk order — so an
// unsorted walk makes the emitted graph (and the --emit-seams contract) differ machine-to-machine.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, normalize, relative } from "node:path";

export function normpath(p: string): string {
  const n = normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

// GITIGNORE = git is the source of truth. We list every file git would keep — tracked ∪
// untracked-but-not-ignored — applying ALL ignore rules (nested .gitignore, negations, core.excludesfile,
// .git/info/exclude) without re-implementing (and drifting from) gitignore semantics. So the walk skips
// build output, vendored deps and `*.min.js` for free. Returns null when the dir isn't a git repo / git is
// absent → callers scan everything (the prior behaviour). Memoized per repo (path-keyed persistence, like
// the other module-level path caches). Escape hatch: SEAM_NO_GITIGNORE=1.
//
// SUBMODULES: `git ls-files` does NOT descend into submodules — a submodule is one gitlink entry, its files
// invisible. A "separate Maven module" is frequently a submodule, and dropping it silently severs a whole
// cross-module dependency arm (e.g. an @Inject'd bean in another module). So we UNION two passes:
//   • `--recurse-submodules` (tracked, INCLUDING submodule contents) — the bulk, submodule arms restored
//   • `--others --exclude-standard` (untracked-not-ignored, superproject only — that flag can't combine
//     with --recurse-submodules) — so brand-new uncommitted source is still scanned.
// (Untracked files INSIDE a submodule are the only gap — rare, and they show up once committed.)
const _gitKeep = new Map<string, Set<string> | null>();
function _gitList(repo: string, args: string[]): string[] | null {
  try {
    const r = spawnSync("git", ["-C", repo, "ls-files", "-z", ...args], { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout.split("\0").filter(Boolean);
  } catch { /* git absent / not a repo */ }
  return null;
}
export function gitNonIgnored(repo: string): Set<string> | null {
  if (process.env.SEAM_NO_GITIGNORE === "1") return null;
  const hit = _gitKeep.get(repo);
  if (hit !== undefined) return hit;
  const tracked = _gitList(repo, ["--recurse-submodules"]);
  let set: Set<string> | null = null;
  if (tracked !== null) {                                // a git repo (else null → scan everything)
    set = new Set(tracked.map((p) => normpath(p)));
    for (const p of _gitList(repo, ["--others", "--exclude-standard"]) ?? []) set.add(normpath(p));
  }
  _gitKeep.set(repo, set);
  return set;
}

// Every ancestor directory (repo-relative) of a kept file — so the walk can PRUNE an ignored dir entirely
// (skip the readdir of a huge gitignored tree) instead of only filtering its files one by one.
function liveDirsOf(files: Set<string>): Set<string> {
  const dirs = new Set<string>();
  for (const f of files) {
    let i = f.lastIndexOf("/");
    while (i > 0) { const d = f.slice(0, i); if (dirs.has(d)) break; dirs.add(d); i = d.lastIndexOf("/"); }
  }
  return dirs;
}

// Walk the repo, filter file paths by predicate (no I/O), then read only the files that pass.
// Yields { rel, abs, text } — the predicate runs on `rel` before any disk read, so callers pay
// only for the files they actually need.
//
// `opts.maxBytes` STAT-skips a file whose on-disk size exceeds the cap BEFORE reading it — so a multi-MB
// generated/minified bundle is never materialized into a string at all (the memory-safe path for huge-repo
// floor scans). `opts.onSkip` is called for each such file so the caller can count/report what was dropped.
export function* walkFiles(
  repo: string, skipDirs: Set<string>, predicate: (rel: string) => boolean,
  opts?: { maxBytes?: number; onSkip?: (rel: string, bytes: number) => void },
): Generator<{ rel: string; abs: string; text: string }> {
  const maxBytes = opts?.maxBytes && opts.maxBytes > 0 ? opts.maxBytes : 0;
  for (const [dir, files] of walk(repo, skipDirs)) {
    for (const fn of files) {
      const abs = join(dir, fn);
      const rel = relative(repo, abs).replace(/\\/g, "/");
      if (!predicate(rel)) continue;
      if (maxBytes) {
        let bytes = 0;
        try { bytes = statSync(abs).size; } catch { continue; }
        if (bytes > maxBytes) { opts!.onSkip?.(rel, bytes); continue; }   // oversized → never read into memory
      }
      let text: string;
      try { text = readFileSync(abs, "utf-8"); } catch { continue; }
      yield { rel, abs, text };
    }
  }
}

export function* walk(root: string, skip: Set<string>): Generator<[string, string[]]> {
  const keep = gitNonIgnored(root);                          // null → no gitignore filtering (prior behaviour)
  const liveDirs = keep ? liveDirsOf(keep) : null;
  const rel = (abs: string) => relative(root, abs).replace(/\\/g, "/");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        const r = rel(join(dir, e.name));
        if (liveDirs && r && !liveDirs.has(r)) continue;     // gitignored dir → don't even readdir it
        dirs.push(join(dir, e.name));
      } else {
        if (keep && !keep.has(rel(join(dir, e.name)))) continue;   // gitignored file → drop
        files.push(e.name);
      }
    }
    // Files yielded in sorted order; dirs pushed reversed so the LIFO stack visits them ascending.
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
    yield [dir, files];
  }
}
