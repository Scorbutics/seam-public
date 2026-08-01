// EVERY UNUSED EXPORT CARRIES ITS ADDRESS — a named symbol with no location is a jump the reader can't make.
//
// THE MEASUREMENT (bench/grep-vs-seam, keycloak, 2026-08-01). `--query contract` on `RealmAdminResource.java`
// listed all 57 of its methods under `## Unused exports` as BARE NAMES — `getRealm` and `updateRealm` among
// them — with an address for none. An agent that wanted exactly those two paged the 1,449-line file in SEVEN
// windows (offsets 160, 240, 420, 592, 1120, 1199, 1259) to find them. The shape already knew where they were.
//
// This is the SAME defect as the `line: None` hole closed in `## Provides` during the content-gap work, in the
// section that fix never reached. Two sections of one shape, one addressless.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const REPO = join(import.meta.dir, "..", "fixtures", "barrel-repo");
const run = (center: string) => {
  const r = spawnSync("bun", [CLI, "--repo", REPO, "--scan", "--query", "contract", "--center", center,
    "--format", "llm-context"], { encoding: "utf-8", timeout: 300_000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};
const unusedSection = (out: string): string[] => {
  const i = out.indexOf("## Unused exports");
  if (i < 0) return [];
  const j = out.indexOf("\n## ", i + 1);
  return out.slice(i, j < 0 ? undefined : j).split("\n").filter((l) => l.startsWith("- "));
};

describe("unused exports are addressable", () => {
  test("every entry carries a file:line", () => {
    // The whole-section assertion, not a sample: one addressed entry beside fifty bare ones is the defect,
    // and a spot check would pass on it.
    const rows = unusedSection(run("src/decl.ts"));
    expect(rows.length).toBeGreaterThan(0);
    const bare = rows.filter((l) => !/:\d+\)/.test(l));
    expect(bare, `these carry no address: ${bare.join(" | ")}`).toEqual([]);
  });

  test("a TYPE export is addressed too — the other code path", () => {
    // Unused exports come from TWO branches: graph members (cited from the node's range) and type/interface/enum
    // exports enumerated from source by regex (cited from the match offset). A fix to one leaves the other bare,
    // which is exactly how the `## Provides` fix missed this section in the first place.
    const rows = unusedSection(run("src/decl.ts"));
    const typeRow = rows.find((l) => l.includes("unusedByAnyone"));
    expect(typeRow).toBeTruthy();
    expect(typeRow).toMatch(/src\/decl\.ts:\d+\)/);
  });

  test("the cited line lands inside the file, not at :0", () => {
    // `at()` renders a bare name when the line is missing rather than fabricating `:0` — a citation that points
    // at line zero sends the reader to the top of the file and reads as an answer.
    const rows = unusedSection(run("src/decl.ts"));
    for (const l of rows) expect(l).not.toContain(":0)");
  });
});
