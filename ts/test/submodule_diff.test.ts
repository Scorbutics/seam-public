// `--submodules` (working-changes + modules): a parent-repo `git diff` only shows a submodule POINTER
// bump, not the file changes inside it. With the flag, the engine drops the pointer noise
// (--ignore-submodules) and appends each submodule's real diff with paths prefixed by the submodule dir
// (--src-prefix/--dst-prefix), so the change decomposes as a normal file. Hermetic: a throwaway
// parent+submodule pair (skips gracefully if the sandbox can't create a file-protocol submodule).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { from_git } from "../src/diff/diff_source.js";

const ROOT = join(tmpdir(), "seam-submod-" + process.pid);
const PARENT = join(ROOT, "parent");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "a@b.c", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "a@b.c" };
const g = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf-8", env });
let ok = false;

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "sub"), { recursive: true });
  g(join(ROOT, "sub"), ["init", "-q"]);
  writeFileSync(join(ROOT, "sub", "lib.ts"), "export function helper(){ return 1; }\n");
  g(join(ROOT, "sub"), ["add", "-A"]); g(join(ROOT, "sub"), ["commit", "-qm", "init"]);
  mkdirSync(PARENT, { recursive: true }); g(PARENT, ["init", "-q"]);
  const add = g(PARENT, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", "../sub", "vendor/sub"]);
  g(PARENT, ["commit", "-qm", "add sub"]);
  writeFileSync(join(PARENT, "app.ts"), "export const y = 2;\n");                          // parent working change (new file)
  writeFileSync(join(PARENT, "vendor", "sub", "lib.ts"), "export function helper(){ return 2; }\n");  // change INSIDE the submodule
  ok = add.status === 0 && existsSync(join(PARENT, "vendor", "sub", ".git"));
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("git submodule diff (--submodules)", () => {
  test("includes the submodule's file change (prefixed), not just the pointer", () => {
    if (!ok) return;   // sandbox couldn't create a file-protocol submodule — skip rather than false-fail
    const without = from_git("HEAD", PARENT);
    const withSub = from_git("HEAD", PARENT, { submodules: true });
    expect(without).toContain("app.ts");
    expect(without).not.toContain("vendor/sub/lib.ts");   // parent diff alone never shows submodule file changes
    expect(withSub).toContain("app.ts");                  // parent change still present
    expect(withSub).toContain("vendor/sub/lib.ts");       // + the submodule's real change, path-prefixed
    expect(withSub).toContain("return 2");                // the actual hunk content from inside the submodule
  });
});
