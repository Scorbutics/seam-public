// Port of src/diff/diff_source.py — service layer for obtaining a unified diff
// (a local .patch/.diff file, or `git diff <range>` + synthesized untracked-file diffs).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export class DiffSourceError extends Error {}

export function from_file(path: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) throw new DiffSourceError(`Diff file not found: ${path}`);
  const text = readFileSync(path, "utf-8");
  if (!text.trim()) throw new DiffSourceError(`Diff file is empty: ${path}`);
  return text;
}

function git(repo: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT")
    throw new DiffSourceError("git executable not found on PATH");
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function from_git(refRange: string, repo = "."): string {
  if (!existsSync(join(repo, ".git")) && !(existsSync(repo) && statSync(repo).isDirectory()))
    throw new DiffSourceError(`Not a git repository: ${repo}`);
  const proc = git(repo, ["diff", "--no-color", "--find-renames", refRange]);
  if (proc.code !== 0) throw new DiffSourceError(`git diff failed (exit ${proc.code}): ${proc.stderr.trim()}`);
  let diffText = proc.stdout;
  if (!refRange.includes("..")) diffText += _untracked_diff(repo);
  if (!diffText.trim()) throw new DiffSourceError(`git diff produced no output for range: ${refRange}`);
  return diffText;
}

function _untracked_diff(repo: string): string {
  const ls = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (ls.code !== 0) return "";
  const chunks: string[] = [];
  for (const path of ls.stdout.split("\0")) {
    if (!path) continue;
    const d = git(repo, ["diff", "--no-color", "--no-index", "/dev/null", path]);
    if (d.code <= 1 && d.stdout) chunks.push(d.stdout);
  }
  return chunks.join("");
}

export function get_diff(opts: { file?: string; git?: string; repo?: string }): string {
  if (opts.file) return from_file(opts.file);
  if (opts.git) return from_git(opts.git, opts.repo ?? ".");
  throw new DiffSourceError("No diff source given: pass --file or --git");
}
