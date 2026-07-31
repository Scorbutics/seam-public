// `--intent` WITHOUT `--center` IS AN ERROR — and the error has to teach, because it replaced a feature.
//
// WHAT WAS REMOVED AND WHY (measured 2026-07-31, keycloak, cache cleared every run). `--scan --intent` used to
// pick the anchor itself via two LLM judge passes. Same phrase, same tree: 18s-97s, and a DIFFERENT mechanism
// cluster on roughly 1 run in 3. The `centers-v1` cache existed per (epoch, intent) purely so grows stayed
// reproducible — i.e. to HIDE that variance by freezing whichever sample landed first, and a stale entry in it
// is what made an earlier measurement in this repo report a historical anchor as current behaviour.
//
// A 3-sample consensus panel was then built and A/B'd against the 1-sample judge: 2 distinct outcomes in 3 runs,
// BOTH arms. Aggregation could not fix it, because the defect is not sampling noise — it is a semantic choice
// made INSIDE a tool whose entire claim is a deterministic fact set. So the choice went back to the caller, who
// has the real task and the conversation; the judge had an intent phrase and a bounded candidate list.
//
// THE LINE THIS FILE DEFENDS: a removal that leaves the caller stuck is a regression, however principled. The
// error must name the flag to pass, and must point at `--locate` for the "I don't know the symbol" case that
// used to be center-first's whole job. Asserting on the TEXT, not just the exit code, is deliberate — a bare
// non-zero exit would pass while saying nothing useful, which is the failure this test exists to prevent.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const REPO = join(import.meta.dir, "..", "fixtures", "route-repo");

const run = (args: string[]) => {
  const r = spawnSync("bun", [CLI, ...args], { encoding: "utf-8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

describe("--intent requires --center", () => {
  test("intent without a center fails rather than guessing an anchor", () => {
    const r = run(["--repo", REPO, "--scan", "--auto", "--concern", "--intent", "how is a payment persisted", "--format", "concern"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--center");
  });

  test("the error TEACHES: it shows the corrected command and points at --locate", () => {
    const r = run(["--repo", REPO, "--scan", "--auto", "--concern", "--intent", "how is a payment persisted", "--format", "concern"]);
    // the fix, spelled out — not just "invalid arguments"
    expect(r.out).toContain("--scan --center");
    // …and the answer to "but I don't know the symbol", which is what center-first used to do for you
    expect(r.out).toContain("--locate");
  });

  test("the intent is ECHOED back, so the corrected command is copy-pasteable", () => {
    const r = run(["--repo", REPO, "--scan", "--auto", "--concern", "--intent", "how is a payment persisted", "--format", "concern"]);
    expect(r.out).toContain("how is a payment persisted");
  });

  test("WITH a center, --intent still works — it shapes the answer, it just no longer chooses the anchor", () => {
    const r = run(["--repo", REPO, "--scan", "--center", "backend/persist.ts#persistPayment",
      "--intent", "how is a payment persisted", "--data-coupling", "floor", "--format", "none"]);
    expect(r.code).toBe(0);
  });
});
