// PRODUCT paths only — drive the CLI's own entry in-process so coverage sees it. No engine internals imported.
import { test } from "bun:test";
const R = "/home/scorbutics/seam-phase0/ts/test/fixtures/route-repo";
// process.exit is stubbed for the WHOLE FILE, not per-run. Restoring it in a `finally` left a window: a
// floating continuation inside the CLI could call the REAL exit after `run` returned, and the process then
// died mid-suite with status 0 — which reads as a clean pass carrying a coverage number for the handful of
// paths that had run so far. A probe that under-reports is worse than no probe.
(process as any).exit = () => {};
const run = async (argv: string[]) => {
  const orig = process.argv;
  process.argv = ["bun", "/home/scorbutics/seam-phase0/ts/src/cli/decompose.ts", ...argv];
  try { const m = await import("/home/scorbutics/seam-phase0/ts/src/cli/decompose.js?p=" + Math.random()); if ((m as any).main) await (m as any).main(); }
  catch (e) { console.error("PROBE PATH FAILED:", argv.join(" "), String(e).slice(0, 120)); }
  finally { process.argv = orig; }
};
test("grow", async () => { await run(["--repo", R, "--scan", "--auto", "--intent", "how is a payment persisted", "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--data-coupling", "floor"]); });
test("shapes", async () => {
  for (const q of ["set", "impact", "contract", "neighborhood", "reach", "refactor", "writers", "coupling"])
    await run(["--repo", R, "--scan", "--query", q, "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--data-coupling", "floor"]);
});
test("concern", async () => { await run(["--repo", R, "--scan", "--auto", "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--concern", "--intent", "how is a payment persisted", "--data-coupling", "floor", "--format", "concern"]); });
// THE PATHS THE FIRST SWEEP MISSED. A probe that under-reports is worse than no probe: it reports a plausible
// number for code it never ran, and the deletion that follows looks safe. These mirror scripts/cli_snapshot.sh
// one-for-one — anything the gate covers, coverage must reach too.
test("dependencies", async () => { await run(["--repo", R, "--scan", "--query", "dependencies", "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--data-coupling", "floor"]); });
test("recall", async () => { await run(["--repo", R, "--scan", "--query", "consumers", "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--recall", "name", "--data-coupling", "floor"]); });
test("ask", async () => { await run(["--repo", R, "--scan", "--query", "ask", "--ask", "who calls persistPayment", "--data-coupling", "floor"]); });
test("depth2", async () => { await run(["--repo", R, "--scan", "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--depth", "2", "--data-coupling", "floor"]); });
test("growfrom", async () => { await run(["--repo", R, "--scan", "--auto", "--intent", "how is a payment persisted", "--grow-from", "backend/persist.ts#persistPayment", "--data-coupling", "floor"]); });
test("centerfirst", async () => { await run(["--repo", R, "--scan", "--auto", "--concern", "--intent", "how is a payment persisted", "--data-coupling", "floor", "--format", "concern"]); });
test("candidates", async () => {
  await run(["--repo", "/home/scorbutics/seam-phase0/ts/test/fixtures/method-repo", "--scan", "--anchor-file", "src/engine.ts",
    "--symbol", "Engine", "--emit-candidates", "/tmp/seam-probe-cand.json"]);
});
test("expand", async () => {
  await run(["--repo", R, "--scan", "--anchor-file", "backend/persist.ts", "--symbol", "persistPayment", "--emit-graph", "/tmp/seam-probe-graph.json", "--data-coupling", "floor"]);
  await run(["--repo", R, "--scan", "--expand-graph", "/tmp/seam-probe-graph.json", "--expand-file", "backend/persist.ts", "--expand-symbol", "persistPayment", "--data-coupling", "floor"]);
});
test("diff", async () => { await run(["--repo", R, "--file", "/home/scorbutics/seam-phase0/sample.patch"]); });
