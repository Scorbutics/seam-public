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

export function from_git(refRange: string, repo = ".", opts: { submodules?: boolean } = {}): string {
  if (!existsSync(join(repo, ".git")) && !(existsSync(repo) && statSync(repo).isDirectory()))
    throw new DiffSourceError(`Not a git repository: ${repo}`);
  // With submodules, drop the parent's submodule POINTER changes (`Subproject commit …`) — the actual
  // file changes inside each submodule are appended below with their paths prefixed by the submodule dir.
  const args = ["diff", "--no-color", "--find-renames"];
  if (opts.submodules) args.push("--ignore-submodules=all");
  const proc = git(repo, [...args, refRange]);
  if (proc.code !== 0) throw new DiffSourceError(`git diff failed (exit ${proc.code}): ${proc.stderr.trim()}`);
  let diffText = proc.stdout;
  if (!refRange.includes("..")) diffText += _untracked_diff(repo);
  if (opts.submodules) for (const sub of _submodule_paths(repo)) diffText += _submodule_diff(repo, sub, refRange);
  if (!diffText.trim()) throw new DiffSourceError(`git diff produced no output for range: ${refRange}`);
  return diffText;
}

// Submodule paths declared in .gitmodules (`git config --get-regexp` over the file). Empty if none.
function _submodule_paths(repo: string): string[] {
  const r = git(repo, ["config", "--file", join(repo, ".gitmodules"), "--get-regexp", "^submodule\\..*\\.path$"]);
  if (r.code !== 0) return [];
  const out: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf(" ");
    if (i < 0) continue;
    const p = line.slice(i + 1).trim();
    if (p) out.push(p);
  }
  return out;
}

// One submodule's diff for the same range, with every path PREFIXED by the submodule dir (so the engine
// treats `vendor/sub/lib.ts` as a normal file). Skips an uninitialised submodule (no checked-out .git).
function _submodule_diff(repo: string, sub: string, refRange: string): string {
  const subRepo = join(repo, sub);
  if (!existsSync(join(subRepo, ".git"))) return "";
  const d = git(subRepo, ["diff", "--no-color", "--find-renames", `--src-prefix=a/${sub}/`, `--dst-prefix=b/${sub}/`, refRange]);
  let out = d.code === 0 ? d.stdout : "";
  if (!refRange.includes("..")) out += _untracked_diff(subRepo, sub);
  return out;
}

function _untracked_diff(repo: string, pathPrefix = ""): string {
  const ls = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (ls.code !== 0) return "";
  const chunks: string[] = [];
  for (const path of ls.stdout.split("\0")) {
    if (!path) continue;
    const pre = pathPrefix ? [`--src-prefix=a/${pathPrefix}/`, `--dst-prefix=b/${pathPrefix}/`] : [];
    const d = git(repo, ["diff", "--no-color", "--no-index", ...pre, "/dev/null", path]);
    if (d.code <= 1 && d.stdout) chunks.push(d.stdout);
  }
  return chunks.join("");
}

export function get_diff(opts: { file?: string; git?: string; repo?: string; submodules?: boolean }): string {
  if (opts.file) return from_file(opts.file);
  if (opts.git) return from_git(opts.git, opts.repo ?? ".", { submodules: opts.submodules });
  throw new DiffSourceError("No diff source given: pass --file or --git");
}
