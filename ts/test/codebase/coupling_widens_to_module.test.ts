// A SYMBOL WITH NO KEY IN ITS SPAN MUST NOT BE TOLD IT HAS NO BOUNDARY.
//
// THE MEASUREMENT (bench/grep-vs-seam, keycloak, 2026-08-01). `--query coupling` scopes its key scan to the
// symbol's span, and a span cannot see a key declared at CLASS level. In JAX-RS — the whole TS↔Java hop the
// cross-language case exists for — that is exactly where the routes live:
//
//     --center RealmAdminResource.java#updateRealm   shared keys: 0
//     --center RealmAdminResource.java#getRealm      shared keys: 0
//     --center RealmAdminResource.java               shared keys: 40, counterpart sites: 57
//
// `@Path("clients")` and its siblings sit at lines 168-220; `updateRealm` starts at 474. So the shape reported
// "touches no db-table / http-route / event boundary — it has no cross-stack coupling" about a file with FORTY
// shared keys. A confident wrong negative, which is the one failure this engine refuses everywhere else.
//
// WHY IT MATTERED MORE THAN IT LOOKS: the flywheel had ALREADY learned those routes — the four keycloak files
// carrying learned keys are exactly realms.ts, RealmAdminResource.java, UIRealmResource.java and AdminRoot.java.
// The moat was warm and addressed by a center the agent does not pick: across a whole benchmark batch, coupling
// was invoked on anchors returning 0 keys in every run but one. This is the third "exists, switched on, not
// REACHED" finding of the day, after the DI index and the coupling routing.
//
// THE WIDENING IS DECLARED. Answering the module's question is right; doing it silently would swap one wrong
// answer for another.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadAddon } from "../../src/codebase/rust_core.js";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "decompose.ts");
const REPO = join(import.meta.dir, "..", "fixtures", "route-repo");
const run = (center: string) => {
  const r = spawnSync("bun", [CLI, "--repo", REPO, "--scan", "--query", "coupling", "--center", center,
    "--format", "llm-context"], { encoding: "utf-8", timeout: 300_000 });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
};
const model = (file: string, sym?: string): any =>
  (loadAddon() as any).projectCoupling(REPO, file, sym ?? undefined);

describe("a keyless symbol widens to its module", () => {
  test("the FILE has keys the symbol's span does not", () => {
    // The precondition. Without it the widening cases below could pass on a file that has no keys either, which
    // would prove nothing about widening.
    const whole = model("backend/persist.ts");
    expect(whole.keys.length).toBeGreaterThan(0);
  });

  test("a symbol with no key in its own span gets the module's boundary", () => {
    // `helperNoKeys` is a function in the same file whose body touches no shared key.
    const m = model("backend/persist.ts", "helperNoKeys");
    expect(m.keys.length).toBeGreaterThan(0);
    expect(m.widenedFrom).toBe("helperNoKeys");
  });

  test("the render DECLARES the widening and names the symbol asked for", () => {
    const out = run("backend/persist.ts#helperNoKeys");
    expect(out).toContain("WIDENED TO THE MODULE");
    expect(out).toContain("'helperNoKeys' has no shared key inside its own span");
    expect(out).not.toContain("No shared key");        // the old, false answer
  });

  test("a symbol that HAS its own key is untouched — no widening, no notice", () => {
    // The negative control. A widen that always fires would answer the module's question for every caller and
    // quietly destroy the symbol-scoped answer, which is the shape's whole point.
    const m = model("backend/persist.ts", "persistPayment");
    expect(m.widenedFrom).toBeFalsy();
    expect(run("backend/persist.ts#persistPayment")).not.toContain("WIDENED");
  });

  test("a file with NO keys anywhere still reports the honest empty", () => {
    // Widening must not manufacture a boundary. When neither the span nor the module has a key, "no shared key"
    // is the true answer and must survive.
    // `page.ts` has no shared key at file level either, so there is nothing to widen TO — verified as a
    // precondition, because a control on a file that DOES have keys would be testing the opposite branch.
    expect(model("app/dashboard/admin/payments/page.ts").keys.length).toBe(0);
    const out = run("app/dashboard/admin/payments/page.ts");
    expect(out).toContain("No shared key");
    expect(out).not.toContain("WIDENED");
  });
});
