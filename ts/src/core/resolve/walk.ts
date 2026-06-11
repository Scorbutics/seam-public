// A repo directory walk that prunes SKIP_DIRS — the shared substrate for the package map and the
// consumer/blast-radius scans (the os.walk equivalent). Order is not guaranteed to match Python's
// os.walk, so callers that need determinism compare results as sets.
import { readdirSync } from "node:fs";
import { join, normalize } from "node:path";

export function normpath(p: string): string {
  const n = normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

export function* walk(root: string, skip: Set<string>): Generator<[string, string[]]> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) { if (!skip.has(e.name)) stack.push(join(dir, e.name)); }
      else files.push(e.name);
    }
    yield [dir, files];
  }
}
