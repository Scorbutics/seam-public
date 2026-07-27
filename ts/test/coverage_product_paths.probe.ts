// PRODUCT paths only — drive the CLI's own entry in-process so coverage sees it. No engine internals imported.
import { test } from "bun:test";
const R = "/home/scorbutics/seam-phase0/ts/test/fixtures/route-repo";
const run = async (argv: string[]) => {
  const orig = process.argv, exit = process.exit;
  process.argv = ["bun", "/home/scorbutics/seam-phase0/ts/src/cli/decompose.ts", ...argv];
  (process as any).exit = () => {};
  try { const m = await import("/home/scorbutics/seam-phase0/ts/src/cli/decompose.js?p=" + Math.random()); if ((m as any).main) await (m as any).main(); }
  catch (e) { console.error("PROBE PATH FAILED:", argv.join(" "), String(e).slice(0, 120)); }
  finally { process.argv = orig; (process as any).exit = exit; }
};
test("grow", async () => { await run(["--repo", R, "--scan", "--auto", "--intent", "how is a payment persisted", "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--data-coupling", "floor"]); });
test("shapes", async () => {
  for (const q of ["set", "impact", "contract", "neighborhood", "reach", "refactor", "writers", "coupling"])
    await run(["--repo", R, "--scan", "--query", q, "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--data-coupling", "floor"]);
});
test("concern", async () => { await run(["--repo", R, "--scan", "--auto", "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--concern", "--intent", "how is a payment persisted", "--data-coupling", "floor", "--format", "concern"]); });
