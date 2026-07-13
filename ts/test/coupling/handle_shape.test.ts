// The `handle` matcher IR shape — `<token>.<verb>()` where `token` is a stateful EXTERNAL SDK HANDLE (a dotted
// receiver path, `client.auth`) and the KEY is the HANDLE IDENTITY itself, NOT a call arg. A session has no
// per-call literal — the coupling is the singleton — so the producer rule (mutate verbs) and the consumer rule
// (read verbs) of the SAME handle carry the same token → emit the same fixed key → they ground. Synthesised by
// the receiver-classifier for a `service`-classified external handle (the counterpart of `repository` for a
// stateful service instead of a table). Pure regex → offline, no tree-sitter guard.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { validateMatcher, runMatcher } from "../../src/codebase/coupling/key_ir.js";
import { applyMatchers } from "../../src/codebase/coupling/key_matcher.js";

describe("handle matcher shape (receiver = stateful external handle)", () => {
  const produce = validateMatcher({ via: "handle", token: "client.auth", verbs: ["signInWithPassword", "signOut"], kind: "service", role: "produces" });
  const consume = validateMatcher({ via: "handle", token: "client.auth", verbs: ["getSession", "getUser"], kind: "service", role: "consumes" });

  test("validates: bare OR dotted receiver + ≥1 verb; rejects empty verbs / an injection token", () => {
    expect(produce?.via).toBe("handle");
    expect((produce as any).token).toBe("client.auth");
    expect(validateMatcher({ via: "handle", token: "auth", verbs: ["signIn"], kind: "service", role: "produces" })?.via).toBe("handle");   // bare receiver ok
    expect(validateMatcher({ via: "handle", token: "client.auth", verbs: [], kind: "service", role: "produces" })).toBeNull();            // no verb → reject
    expect(validateMatcher({ via: "handle", token: "a.b(", verbs: ["x"], kind: "service", role: "produces" })).toBeNull();               // metachar → reject
  });

  test("the HANDLE IDENTITY is the key (SAME for producer + consumer); scoped to the receiver path", async () => {
    const code = `
      await client.auth.signInWithPassword({ email, password });
      await client.auth.signOut();
      const { data } = await client.auth.getSession();
      const u = await client.auth.getUser();
      client.from('members').select();          // a DIFFERENT sub-handle (.from) → NOT matched by this rule
      other.auth.getSession();                  // a different root receiver → ignored
    `;
    const p = (await runMatcher(produce!, "x.ts", code)).map((h) => `${h.value}:${h.produces ? "P" : "C"}`).sort();
    const c = (await runMatcher(consume!, "x.ts", code)).map((h) => `${h.value}:${h.produces ? "P" : "C"}`).sort();
    // both sides emit the SAME fixed key (the handle slug) so they ground; `.from`/`other.auth` are excluded
    expect(p).toEqual(["client-auth:P", "client-auth:P"]);          // signInWithPassword + signOut → produces
    expect(c).toEqual(["client-auth:C", "client-auth:C"]);          // getSession + getUser → consumes
  });
});

// END-TO-END grounding: two files operate the same external handle across an opaque boundary (no call between
// them). The producer (signIn) and the consumer (getSession) must ground on the ONE handle key — the coupling a
// call-trace can't see, and the reason private-app sign-in stayed EQUAL (an ungrounded external-SDK terminal).
describe("handle matchers ground a producer↔consumer over an external SDK handle", () => {
  let REPO: string;
  const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };
  beforeAll(() => {
    REPO = mkdtempSync(join(tmpdir(), "handle-couple-"));
    w("src/login.ts", `import { client } from "@vendor/sdk";\nexport async function signIn(email: string, pwd: string) {\n  return client.auth.signInWithPassword({ email, password: pwd });\n}\n`);
    w("src/whoami.ts", `import { client } from "@vendor/sdk";\nexport async function whoami() {\n  const { data } = await client.auth.getSession();\n  return data;\n}\n`);
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the session handle key carries BOTH a producer (login) and a consumer (whoami)", async () => {
    const produce = validateMatcher({ via: "handle", token: "client.auth", verbs: ["signInWithPassword", "signOut"], kind: "service", role: "produces" })!;
    const consume = validateMatcher({ via: "handle", token: "client.auth", verbs: ["getSession", "getUser"], kind: "service", role: "consumes" })!;
    const idx = await applyMatchers(REPO, [produce, consume]);
    const entry = idx.get("service client-auth");
    expect(entry).toBeTruthy();
    expect(entry!.producers.map((p) => p.file)).toContain("src/login.ts");   // signIn establishes the session
    expect(entry!.consumers.map((c) => c.file)).toContain("src/whoami.ts");  // getSession reads it → grounded coupling
  });
});
