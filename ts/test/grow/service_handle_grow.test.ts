// END-TO-END: a grow surfaces a learned SERVICE-HANDLE coupling. An external-SDK handle (`client.auth`) whose
// producer (signIn → signInWithPassword) and consumer (whoami → getSession) live in DIFFERENT files couples over
// the handle's singleton state — a boundary a call-trace can't see (the flow exits into a 3rd-party service). With
// the `service` medium + `handle` matcher, the grow grounds it: a `service-write` crossing from the anchor to the
// `client-auth` boundary, and the cross-file consumer pulled in. Hermetic: a throwaway repo + primed `.seam` handle
// matchers (regex apply, no LLM); the grow gates on tree-sitter (complement materialisation parses).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { persistMatchers, _resetMatcherCacheMem } from "../../src/codebase/coupling/key_store.js";
import { validateMatcher } from "../../src/codebase/coupling/key_ir.js";
import { available } from "../../src/codebase/atoms.js";

describe("a grow grounds a learned service-handle coupling (producer ⇄ consumer over an external SDK handle)", () => {
  const REPO = join(tmpdir(), "seam-svc-handle-" + process.pid);
  const git = (...a: string[]) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf-8" });
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    mkdirSync(REPO, { recursive: true });
    git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
    // PRODUCER — establishes the session (mutates the handle state)…
    write("src/login.ts", `import { client } from "@vendor/sdk";\nexport async function signIn(email: string, pwd: string) {\n  return client.auth.signInWithPassword({ email, password: pwd });\n}\n`);
    // …CONSUMER — reads the session (in ANOTHER file, no call between them: the coupling is the shared handle).
    write("src/session.ts", `import { client } from "@vendor/sdk";\nexport async function whoami() {\n  const { data } = await client.auth.getSession();\n  return data;\n}\n`);
    // primed handle matchers (as the receiver-classifier would synthesise them): producer + consumer on client.auth.
    const produce = validateMatcher({ via: "handle", token: "client.auth", verbs: ["signInWithPassword", "signOut"], kind: "service", role: "produces" })!;
    const consume = validateMatcher({ via: "handle", token: "client.auth", verbs: ["getSession", "getUser"], kind: "service", role: "consumes" })!;
    persistMatchers(REPO, [produce, consume]);
    git("add", "-A");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the anchor writes a service boundary and the cross-file session consumer is pulled in", async () => {
    if (!available()) return;   // no tree-sitter → no complement units to cross into
    _resetMatcherCacheMem();
    const [data] = await grow_to_terminals(REPO, "src/login.ts", "signIn",
      { dataCoupling: true, intent: "how does a user sign in and establish a session" });
    const edges = (data.edges ?? []) as any[];
    const nodes = (data.nodes ?? []) as any[];
    // (a) a grounded service crossing FROM the anchor into the handle boundary (a boundary a call-trace can't reach)
    expect(edges.some((e) => e.kind === "service-write")).toBe(true);
    // (b) the boundary node carries the `service` medium kind (so isBoundarySeam grounds it, not a bare code node)
    expect(nodes.some((n) => n.coupling && n.kind === "service")).toBe(true);
    // (c) the CROSS-FILE consumer (session.ts, reached only via the shared handle) is in the footprint
    expect(nodes.some((n) => n.file?.endsWith("src/session.ts"))).toBe(true);
  });
});
