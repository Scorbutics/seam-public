// THE CONTRACT'S CONSUMER CITATIONS CARRY A LINE — and the line is the USE SITE.
//
// WHY THIS EXISTS. `bench/grep-vs-seam/verification-tax.ts` replays each stored benchmark run, recovers what
// Seam actually printed, and bins every shell command the agent issued AFTER the answer. The dominant bin on two
// of three cases was re-reading files Seam had ALREADY cited: cal.com cited 416 locations and showed source text
// for 4. The mechanism was this shape — `--query contract` emitted its consumers as bare paths
// (`← postHandler (…/_post.ts)`), and render/snippets.ts yields nothing for a citation with no line. So the
// shape that answers "how is this actually called" handed over pointers with nothing to dereference, and the
// agent went and opened the files.
//
// ASSERT THE TEXT AT THE CITED LINE, NOT MERELY THAT A LINE EXISTS. This is the whole point of the file. The
// first cut of the fix DID emit a line for every consumer and the render DID grow snippets — and they were
// WRONG: internal lines are 0-based (`to1` in project_set.rs is the one conversion point) and the value was
// passed through raw, so the snippet for a real call site rendered `*/`, the comment terminator one line above
// the consuming function. A test that only checked `line > 0` passes on that. A snippet pointing at the wrong
// code is worse than no snippet, because a bare path at least tells the reader to go look.
//
// The two paths differ and both are covered: a VALUE export is cited at the call site (from the edge), and a
// TYPE export has no call site at all, so it is cited at the import statement that binds it.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { projectContract } from "../helpers/shapes.js";
import { renderContract } from "../../src/codebase/render/shapes.js";
import { makeSnippetReader } from "../../src/codebase/render/snippets.js";

let REPO: string;
let contract: any;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
const provided = (symbol: string): any => contract.provides.find((p: any) => p.symbol === symbol);

// The 1-BASED line the citation claims, read back out of the real file. This is the assertion that has teeth.
const textAt = (file: string, line: number): string => readFileSync(join(REPO, file), "utf-8").split("\n")[line - 1];

beforeAll(async () => {
  REPO = mkdtempSync(join(tmpdir(), "seam-contract-line-"));
  w("src/util.ts", [
    "export type Opts = { loud: boolean }",
    "",
    "export function shout(msg: string, opts: Opts): string {",
    "  return opts.loud ? msg.toUpperCase() : msg",
    "}",
  ].join("\n"));
  // The call site is deliberately FAR from the declaration and preceded by a doc comment, so a citation that
  // lands on the consuming symbol's declaration — or one line off it — is visibly different from the right one.
  w("src/caller.ts", [
    'import { shout } from "./util"',
    "",
    "/**",
    " * A doc comment whose terminator sits immediately above the declaration.",
    " * The off-by-one bug this file exists for cited THIS block instead of the call.",
    " */",
    "export function announce(name: string): string {",
    "  const greeting = `hello ${name}`",
    "  return shout(greeting, { loud: true })",
    "}",
  ].join("\n"));
  // A TYPE consumer: `Opts` is never called, so the only real location is the import that binds it.
  w("src/typed.ts", [
    "// leading comment so the import is not on line 1 by accident",
    'import type { Opts } from "./util"',
    "",
    "export const DEFAULTS: Opts = { loud: false }",
  ].join("\n"));
  contract = await projectContract(REPO, "src/util.ts");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("contract consumers carry a dereferenceable citation", () => {
  test("a value export is cited at the CALL SITE, and the text there is the call", () => {
    const c = provided("shout").consumers.find((x: any) => x.file === "src/caller.ts");
    expect(c).toBeDefined();
    expect(c.line).toBeGreaterThan(0);
    // THE ASSERTION WITH TEETH. `line > 0` alone passed on the off-by-one that shipped `*/`.
    expect(textAt(c.file, c.line)).toContain("shout(greeting");
  });

  test("a type export is cited at the IMPORT that binds it, not at line 1", () => {
    const c = provided("Opts").consumers.find((x: any) => x.file === "src/typed.ts");
    expect(c).toBeDefined();
    expect(textAt(c.file, c.line)).toContain("import type { Opts }");
  });

  test("the render prints file:line and the snippet marks that exact line", () => {
    const out = renderContract(contract, makeSnippetReader(REPO, 2));
    const c = provided("shout").consumers.find((x: any) => x.file === "src/caller.ts");
    expect(out).toContain(`(src/caller.ts:${c.line})`);
    // The `>` gutter marks the cited line; it must carry the call, so the citation and the shown code agree.
    const marked = out.split("\n").filter((l) => /^\s+\d+>/.test(l));
    expect(marked.some((l) => l.includes("shout(greeting"))).toBe(true);
  });

  test("without a snippet reader the render still cites the line and adds no source text", () => {
    // The citation is the durable part; snippets are a budgeted extra (`--no-snippets`). Losing the line when
    // the reader is absent would put us straight back to the bare-path failure this file was written for.
    const out = renderContract(contract);
    expect(out).toContain("(src/caller.ts:9)");
    expect(out.split("\n").some((l) => /^\s+\d+[│>]/.test(l))).toBe(false);
  });
});
