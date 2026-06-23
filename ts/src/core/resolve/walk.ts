// A repo directory walk that prunes SKIP_DIRS — the shared substrate for the package map and the
// consumer/blast-radius scans (the os.walk equivalent). Entries are sorted so the traversal is
// DETERMINISTIC across machines: raw readdir order varies by OS/filesystem (ext4 vs overlayfs,
// Linux vs macOS), and downstream consumers assign positional graph ids in walk order — so an
// unsorted walk makes the emitted graph (and the --emit-seams contract) differ machine-to-machine.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";

export function normpath(p: string): string {
  const n = normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
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
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) { if (!skip.has(e.name)) dirs.push(join(dir, e.name)); }
      else files.push(e.name);
    }
    // Files yielded in sorted order; dirs pushed reversed so the LIFO stack visits them ascending.
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
    yield [dir, files];
  }
}
