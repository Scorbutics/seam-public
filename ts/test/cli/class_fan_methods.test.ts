// CLASS ANCHOR → PER-METHOD FLOWS. Anchoring a bare `--center <ClassFile>` used to collapse the whole class onto
// one class node: the coupling floor found writes across the class body but hung them ALL off the class, so the
// render showed ONE db-write and hid the rest behind an `untraced-or-unused-methods` blindspot. A class is really
// a BUNDLE of per-method flows (createBooking → write, cancelBooking → delete, updateProfile → other table), so a
// bare class center now FANS into a per-method star and the concern `Out` section attributes each write to the
// METHOD that makes it — deduped, so N call sites of one table under a method are one line. Offline. Guards on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let REPO: string;
const w = (rel: string, t: string) => { mkdirSync(join(REPO, dirname(rel)), { recursive: true }); writeFileSync(join(REPO, rel), t); };

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "class-fan-"));
  w("jpa/MemberBooking.java", `package jpa;\nimport jakarta.persistence.*;\n@Entity\npublic class MemberBooking { String id; }\n`);
  w("jpa/MemberProfile.java", `package jpa;\nimport jakarta.persistence.*;\n@Entity\npublic class MemberProfile { String id; }\n`);
  w("orm/JpaEntityManager.java", `package orm;\nimport jakarta.persistence.EntityManager;\npublic abstract class JpaEntityManager { protected EntityManager mEntityManager; public <T> T save(T e){ mEntityManager.merge(e); return e; } }\n`);
  w("orm/RequestScopedJpaEntityManager.java", `package orm;\npublic class RequestScopedJpaEntityManager extends JpaEntityManager { }\n`);
  // one bean, several methods, each with its OWN boundary — createBooking/updateBooking write MemberBooking,
  // updateProfile writes MemberProfile. The class node alone would surface only the first write.
  w("cdi/BookingsBean.java", `package cdi;\nimport orm.RequestScopedJpaEntityManager;\nimport jpa.MemberBooking;\nimport jpa.MemberProfile;\npublic class BookingsBean {\n  RequestScopedJpaEntityManager mJpaEntityManager;\n  public MemberBooking createBooking(MemberBooking b){ return mJpaEntityManager.save(b); }\n  public MemberBooking updateBooking(MemberBooking b){ return mJpaEntityManager.save(b); }\n  public MemberProfile updateProfile(MemberProfile p){ return mJpaEntityManager.save(p); }\n}\n`);
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

const run = (fmt: string) => spawnSync("bun",
  ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto", "--data-coupling", "floor", "--verbose",
    "--center", "cdi/BookingsBean.java", "--intent", "how bookings are managed", "--format", fmt],
  { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });

describe("bare class --center fans into per-method flows", () => {
  test("the class fans structurally into its methods (not a collapsed single class node)", () => {
    if (!available()) return;
    const r = run("concern");
    expect(r.stderr).toContain("is a class 'BookingsBean'");
    expect(r.stderr).toContain("fanning into a per-method star");
    // every method is a mechanism of the concern — none hidden behind the class node
    for (const m of ["createBooking", "updateBooking", "updateProfile"]) expect(r.stdout).toContain(`BookingsBean.${m}`);
  }, 60000);

  test("a bare class + --format agent UPGRADES to the concern STAR (so no method is missing); a pinned #method keeps the agent spine", () => {
    if (!available()) return;
    // bare class → the star view even though the caller asked for agent (a class is many mechanisms, not one line)
    const cls = spawnSync("bun",
      ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto", "--data-coupling", "floor", "--verbose",
        "--center", "cdi/BookingsBean.java", "--intent", "how bookings are managed", "--format", "agent"],
      { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });
    expect(cls.stderr).toContain("rendering the per-method STAR view");
    expect(cls.stdout).toContain("# Concern map");
    for (const m of ["createBooking", "updateBooking", "updateProfile"]) expect(cls.stdout).toContain(`BookingsBean.${m}`);
    // a PINNED method stays the deep single-method agent spine (the LINE view)
    const one = spawnSync("bun",
      ["src/cli/decompose.ts", "--repo", REPO, "--scan", "--auto", "--data-coupling", "floor",
        "--center", "cdi/BookingsBean.java#createBooking", "--intent", "how bookings are managed", "--format", "agent"],
      { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "0" }, encoding: "utf-8" });
    expect(one.stdout).toContain("# Agent map");
    expect(one.stdout).toMatch(/anchor: createBooking\b/);
  }, 60000);

  test("the Out section attributes each write to the METHOD that makes it, deduped by table", () => {
    if (!available()) return;
    const out = run("concern").stdout;
    const seg = out.slice(out.indexOf("## Out"), out.indexOf("## Blindspots") >= 0 ? out.indexOf("## Blindspots") : undefined);
    // per-method attribution: the method name is on the LEFT of the write arrow (not a bare `●`)
    expect(seg).toMatch(/BookingsBean\.createBooking ──writes──▶ db "MemberBooking"/);
    expect(seg).toMatch(/BookingsBean\.updateBooking ──writes──▶ db "MemberBooking"/);
    expect(seg).toMatch(/──writes──▶ db "MemberProfile"/);   // updateProfile's distinct table
    // createBooking + updateBooking both write MemberBooking — but each is ONE line (dedup per method+table),
    // so MemberBooking appears exactly twice (once per writing method), not once per call site.
    expect((seg.match(/──writes──▶ db "MemberBooking"/g) ?? []).length).toBe(2);
  }, 60000);
});
