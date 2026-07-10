// REGRESSION — the DI PROVIDER-FACTORY hop (SEAM_PROVIDER_HOP=1). A chained `session.groups().createGroup()` must
// be followed PAST the runtime factory to the interface's concrete impl, so a DI-hidden persistence is reached
// instead of the flow dead-ending at the caller. GROUNDED: the hop seeds only because `groups()` is declared to
// return `GroupProvider` (an in-repo interface WITH impls) — a closed structural fact, not a method-name guess.
// Mirrors Keycloak's `KeycloakSession.groups()` → `JpaRealmProvider`. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { build_footprint } from "../../src/codebase/scan/index.js";
import { _resetImplIndexMem } from "../../src/codebase/scan/interface_index.js";
import { available } from "../../src/codebase/atoms.js";

let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "provider-hop-"));
  // The factory interface: `groups()` DECLARED to return the GroupProvider interface (the grounded accessor).
  w("app/Session.java", `package app;\npublic interface Session {\n  GroupProvider groups();\n}\n`);
  w("app/GroupProvider.java", `package app;\npublic interface GroupProvider {\n  void createGroup(String name);\n}\n`);
  // The concrete impl — the runtime binding a static scan can't see — persists an @Entity.
  w("app/JpaGroupProvider.java", `package app;\nimport jakarta.persistence.EntityManager;\npublic class JpaGroupProvider implements GroupProvider {\n  EntityManager em;\n  public void createGroup(String name) {\n    GroupEntity e = new GroupEntity();\n    em.persist(e);\n  }\n}\n`);
  w("app/GroupEntity.java", `package app;\nimport jakarta.persistence.Entity;\n@Entity\npublic class GroupEntity {\n  String name;\n}\n`);
  // The ANCHOR — a handler that hops through the factory: session.groups().createGroup(name).
  w("app/Handler.java", `package app;\npublic class Handler {\n  Session session;\n  public void addGroup(String name) {\n    session.groups().createGroup(name);\n  }\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const footprintSymbols = async (providerHop: boolean): Promise<Set<string>> => {
  const prev = process.env.SEAM_PROVIDER_HOP;
  process.env.SEAM_PROVIDER_HOP = providerHop ? "1" : "0";
  _resetImplIndexMem();
  try {
    const g: any = await build_footprint(REPO, "app/Handler.java", "addGroup", { direction: "down", dataCoupling: false });
    return new Set((g.nodes ?? []).map((n: any) => String(n.symbol)));
  } finally { if (prev === undefined) delete process.env.SEAM_PROVIDER_HOP; else process.env.SEAM_PROVIDER_HOP = prev; }
};

describe("DI provider-factory hop (SEAM_PROVIDER_HOP)", () => {
  test("with the hop ON, session.groups() is followed to the GroupProvider impl (JpaGroupProvider)", async () => {
    if (!available()) return;
    expect(await footprintSymbols(true)).toContain("JpaGroupProvider");
  });

  test("with the hop OFF (default), the factory chain is NOT followed (opt-in, no behaviour change)", async () => {
    if (!available()) return;
    expect(await footprintSymbols(false)).not.toContain("JpaGroupProvider");
  });
});
