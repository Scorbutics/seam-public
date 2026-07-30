// CONFIG-KEY COUPLING — a shared environment variable across four languages, and the one SYMMETRIC key kind.
//
// Found by `bench/coupling` on its first run, which is what that benchmark is for. The adapter set was
// db-table / http-route / data-file / egress / binding / member-access, and a shared config key is none of those:
// `api/notify.ts` reads `process.env.NOTIFY_WEBHOOK_URL`, `backend/NotifyWorker.java` reads
// `System.getenv("NOTIFY_WEBHOOK_URL")`, and nothing whatsoever links them — no import, no call, no table, no
// route. Redefine what the value means on one side and the other three silently change behaviour. The layer
// resolved nothing at all, so the gap was invisible until something asked.
//
// SYMMETRY IS THE POINT, and it is why this needed an engine change rather than just an adapter. Every other kind
// has a direction: a table couples a WRITER to a READER, a route a CALLER to a HANDLER, so "the other side" is the
// opposite role and `other_side` returns the complement. A config key couples READER to READER — nobody writes
// it. A strict complement lookup returns the empty set for precisely the case the kind exists to catch, so
// `other_side` unions both sides for this kind alone.
//
// The fixture is `bench/coupling/repo`, shared with the benchmark rather than copied, so the two cannot drift.
import { describe, expect, test, beforeAll } from "bun:test";
import { projectCoupling } from "../helpers/shapes.js";
import { renderCoupling } from "../../src/codebase/render/shapes.js";

const REPO = "../bench/coupling/repo";
let model: any;
const keyOf = (v: string) => (model.keys ?? []).find((k: any) => k.value === v);

beforeAll(async () => { model = await projectCoupling(REPO, "api/notify.ts", "notifyUrl"); });

describe("a shared config key couples stacks that share no code edge", () => {
  test("the key is formed at all", () => {
    const k = keyOf("NOTIFY_WEBHOOK_URL");
    expect(k).toBeTruthy();
    expect(k.kind).toBe("config-key");
  });

  test("it reaches THREE other languages from a TypeScript anchor", () => {
    // Java, Ruby and Python. Seam is a multi-language tool and a config key is the most language-agnostic
    // boundary there is — a bare string — so an adapter that only worked for the TS↔Java pair would be a
    // single-idiom adapter wearing a cross-language name.
    const files = keyOf("NOTIFY_WEBHOOK_URL").sides.map((s: any) => s.file).sort();
    expect(files).toEqual(["backend/NotifyWorker.java", "reporting/notify.rb", "worker/dispatch.py"]);
  });

  test("four different ACCESSOR IDIOMS resolve, not just four languages", () => {
    // process.env.X dotted (no string literal at all), System.getenv("X"), ENV["X"], os.environ.get("X").
    // An adapter is only as multi-language as the idioms it was tested on.
    const lines = keyOf("NOTIFY_WEBHOOK_URL").sides.map((s: any) => `${s.file}:${s.line}`).sort();
    expect(lines).toEqual(["backend/NotifyWorker.java:7", "reporting/notify.rb:5", "worker/dispatch.py:7"]);
  });
});

describe("the direction reported is what the counterpart DOES", () => {
  test("a reader of the same key is labelled `reads`, not `writes`", () => {
    // THE BUG THIS PINS: the counterpart's role was inferred as the complement of the anchor's role — correct for
    // every asymmetric kind and silently false here. The first working version of this feature rendered
    // `[method, writes NOTIFY_WEBHOOK_URL]` for all three counterparts, telling a reader that the Java worker
    // SETS the variable when it only reads it. That is a claim an agent would act on.
    for (const s of keyOf("NOTIFY_WEBHOOK_URL").sides) expect(s.role).toBe("reads");
    expect(keyOf("NOTIFY_WEBHOOK_URL").anchorRole).toBe("reads");
  });

  test("the render explains the symmetry instead of leaving the directional prose to mislead", () => {
    const t = renderCoupling(model as any);
    expect(t).toContain("CONFIG KEYS ARE SYMMETRIC");
    // and it must still say what a `←` would mean, so the explanation does not overreach into "never a write"
    expect(t).toContain("process.env.X");
  });
});

describe("the symmetric union does not invent couplings", () => {
  test("a key read in exactly ONE place has no counterpart — a file is not its own other side", async () => {
    // FALSIFICATION of the union. Unioning producers and consumers is what makes reader↔reader pairs resolve,
    // and it is also the one change that could pair a file with itself. `SOLO_ONLY_FLAG` is read in api/solo.ts
    // and nowhere else in the fixture.
    const solo = await projectCoupling(REPO, "api/solo.ts", "solo");
    const k = (solo.keys ?? []).find((x: any) => x.value === "SOLO_ONLY_FLAG");
    // either the key is absent, or present with zero sides — never with itself as a side
    expect(k?.sides ?? []).toEqual([]);
    expect((solo.keys ?? []).flatMap((x: any) => x.sides.map((s: any) => s.file))).not.toContain("api/solo.ts");
  });
});
