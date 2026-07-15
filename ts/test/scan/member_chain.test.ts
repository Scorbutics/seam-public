// CHAINED member-call resolution — `a.b.method()` where the receiver is a MULTI-hop member chain, resolved
// structurally (tree-sitter, no type checker): base var TYPE → field TYPE → … → the class whose method to
// follow. Each hop is an explicit `field: Type` annotation + the deterministic import resolver — GROUNDED.
// (keycloak kc_3: `adminClient.users.create` — the chain resolves; only the hook-destructured BASE var, which
// carries no annotation, is out of reach, and that's asserted here as the honest limit.)
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_dependency_graph } from "../../src/codebase/scan/down/dependency_graph.js";
import { available } from "../../src/codebase/atoms.js";

const REPO = join(tmpdir(), "seam-member-chain-" + process.pid);
const w = (rel: string, t: string) => { const p = join(REPO, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  w("src/Users.ts", "export class Users {\n  create() { return fetch('/admin/realms/x/users', { method: 'POST' }); }\n}\n");
  w("src/Client.ts", "import { Users } from './Users';\nexport class KeycloakAdminClient {\n  public users: Users = new Users();\n}\n");
  // a TYPED base (a param annotated `: KeycloakAdminClient`) — the chain fully resolves
  w("src/Typed.ts", "import { KeycloakAdminClient } from './Client';\nexport function save(client: KeycloakAdminClient) {\n  return client.users.create();\n}\n");
  // an UNTYPED base (destructured from a hook, no annotation) — the chain BLOCKS at the base (the known limit)
  w("src/useClient.ts", "import { KeycloakAdminClient } from './Client';\nexport const useClient = () => ({ adminClient: new KeycloakAdminClient() });\n");
  w("src/Hooked.ts", "import { useClient } from './useClient';\nexport function save() {\n  const { adminClient } = useClient();\n  return adminClient.users.create();\n}\n");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("chained member-call resolution (a.b.method)", () => {
  test("a TYPED base resolves the whole chain to the final method (client.users.create → Users.create)", async () => {
    if (!available()) return;   // needs tree-sitter
    const g = await build_dependency_graph(REPO, "src/Typed.ts", "save");
    const reached = g.nodes.some((n: any) => n.symbol === "create" && (n.file || "").endsWith("Users.ts"));
    expect(reached).toBe(true);                                   // the chain crossed users → Users → create
    const e = g.edges.find((x: any) => x.kind === "call" && g.nodes.find((n: any) => n.id === x.to)?.symbol === "create");
    expect(e?.provenance).toBe("RESOLVED_PARTIAL");               // inferred binding (the class path is proven)
  });

  test("an UNTYPED (hook-destructured) base blocks at the base — no false edge fabricated", async () => {
    if (!available()) return;
    const g = await build_dependency_graph(REPO, "src/Hooked.ts", "save");
    // `adminClient` has no type annotation, so the chain can't start — `create` is NOT reached (honest limit,
    // not a guess). This is the exact wall kc_3 hits; resolving it needs the hook-return type (LSP / a
    // React-context walk), which this structural pass deliberately does not fabricate.
    expect(g.nodes.some((n: any) => n.symbol === "create" && (n.file || "").endsWith("Users.ts"))).toBe(false);
  });
});
