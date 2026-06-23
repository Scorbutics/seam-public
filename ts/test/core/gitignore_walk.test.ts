// The walk respects .gitignore (git is the source of truth: `git ls-files`), so build output, vendored
// deps and *.min.js are skipped — and a git SUBMODULE's contents are INCLUDED (plain `git ls-files` omits
// them; we union `--recurse-submodules`). Hermetic: throwaway git repos under tmp. Each test uses a unique
// repo path so the per-repo memo in gitNonIgnored never goes stale across cases.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walk, gitNonIgnored } from "../../src/core/resolve/walk.js";

const git = (repo: string, ...args: string[]) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
const initRepo = (repo: string) => {
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");
};
const write = (repo: string, rel: string, text: string) => { mkdirSync(join(repo, rel, ".."), { recursive: true }); writeFileSync(join(repo, rel), text); };
const walked = (repo: string) => {
  const out: string[] = [];
  for (const [dir, files] of walk(repo, new Set([".git"]))) for (const f of files) out.push(join(dir, f).replace(repo + "/", ""));
  return out.sort();
};

describe("walk respects .gitignore", () => {
  const REPO = join(tmpdir(), "seam-gi-walk-" + process.pid);
  beforeAll(() => {
    initRepo(REPO);
    write(REPO, "src/app.js", "fetch('/api/x');\n");
    write(REPO, "app.min.js", "minified\n");
    write(REPO, "dist/bundle.js", "built\n");
    write(REPO, "vendor/lib.js", "vendored\n");
    write(REPO, ".gitignore", "dist/\n*.min.js\nvendor/\n");
    git(REPO, "add", "-A");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("gitignored files and dirs are dropped; tracked source is kept", () => {
    const got = walked(REPO);
    expect(got).toContain("src/app.js");
    expect(got).toContain(".gitignore");
    expect(got).not.toContain("app.min.js");        // *.min.js ignored
    expect(got.some((f) => f.startsWith("dist/"))).toBe(false);     // ignored dir pruned
    expect(got.some((f) => f.startsWith("vendor/"))).toBe(false);
  });

  test("an UNTRACKED (not-yet-added) non-ignored file is still scanned — new code isn't invisible", () => {
    write(REPO, "src/fresh.js", "fetch('/api/new');\n");
    // gitNonIgnored memoizes per repo path; this case asserts the union includes --others, independent of memo
    const keep = gitNonIgnored(REPO + "/.");   // distinct path key → fresh git query incl. --others
    expect([...(keep ?? [])].some((f) => f.endsWith("src/fresh.js"))).toBe(true);
  });

  test("SEAM_NO_GITIGNORE=1 disables filtering (escape hatch)", () => {
    const prev = process.env.SEAM_NO_GITIGNORE;
    process.env.SEAM_NO_GITIGNORE = "1";
    try { expect(gitNonIgnored(REPO + "/./.")).toBeNull(); }   // unique key; null → caller scans everything
    finally { if (prev === undefined) delete process.env.SEAM_NO_GITIGNORE; else process.env.SEAM_NO_GITIGNORE = prev; }
  });
});

describe("non-git directory → no filtering (prior behaviour)", () => {
  const REPO = join(tmpdir(), "seam-gi-nogit-" + process.pid);
  beforeAll(() => { rmSync(REPO, { recursive: true, force: true }); write(REPO, "a.js", "x"); write(REPO, "b.min.js", "y"); });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));
  test("gitNonIgnored is null and every file (even *.min.js) is walked", () => {
    expect(gitNonIgnored(REPO)).toBeNull();
    expect(walked(REPO)).toEqual(["a.js", "b.min.js"]);
  });
});

describe("git submodule contents are included", () => {
  const SUPER = join(tmpdir(), "seam-gi-super-" + process.pid);
  const SUB = join(tmpdir(), "seam-gi-sub-" + process.pid);
  let submoduleAdded = false;
  beforeAll(() => {
    initRepo(SUB);
    write(SUB, "com/x/bean/FileNoteItemBean.java", "package com.x.bean;\npublic class FileNoteItemBean {}\n");
    git(SUB, "add", "-A"); git(SUB, "commit", "-q", "-m", "init");
    initRepo(SUPER);
    write(SUPER, "web/Svc.java", "package web;\npublic class Svc {}\n");
    // file:// submodules are gated by protocol.file.allow; if the env forbids it, skip the assertion.
    const r = git(SUPER, "-c", "protocol.file.allow=always", "submodule", "add", "-q", SUB, "core");
    submoduleAdded = r.status === 0;
    if (submoduleAdded) { git(SUPER, "add", "-A"); git(SUPER, "commit", "-q", "-m", "super"); }
  });
  afterAll(() => { rmSync(SUPER, { recursive: true, force: true }); rmSync(SUB, { recursive: true, force: true }); });

  test("the submodule's tracked file is in the walked set (plain ls-files would omit it)", () => {
    if (!submoduleAdded) return;   // file-protocol submodules disabled in this env → skip
    const keep = gitNonIgnored(SUPER);
    expect([...(keep ?? [])].some((f) => f.endsWith("core/com/x/bean/FileNoteItemBean.java"))).toBe(true);
    expect([...(keep ?? [])].some((f) => f.endsWith("web/Svc.java"))).toBe(true);
  });
});
