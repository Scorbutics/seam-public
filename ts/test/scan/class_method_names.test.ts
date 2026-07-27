// REGRESSION: a class/interface method's NAME comes from the tree-sitter `name` field, never the leading
// return TYPE. `_class_methods` / `_type_methods` matched `_MEMBER_NAME` (property_identifier — JS/TS), which
// MISSES Java method names (`identifier`): a Java class surfaced ZERO methods, and the footprint fell back to
// the return-type DEPENDENCY classes (BookingData/SubList/User), so the spine read as those types instead of
// the methods. Fixed to read the field via `_name_of`. Guards on tree-sitter.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeCtx, available } from "../../src/codebase/atoms.js";
import { _read } from "../../src/codebase/ast_units.js";
import { _class_methods, _type_methods } from "../../src/codebase/scan/ast_class.js";
import { build_footprint } from "../../src/codebase/scan/footprint.js";

describe("class/interface method names use the tree-sitter name field, not the return type", () => {
  test("Java methods that RETURN a class type are named by the method, not the type", async () => {
    if (!available()) return;
    const repo = mkdtempSync(join(tmpdir(), "cmn-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "Svc.java"),
        `package a;\npublic class Svc {\n  public BookingData loadBooking(int id){ return repo.find(id); }\n  public SubList getItems(){ return l.sub(); }\n  public Svc(){}\n}\n`);
      const rd = _read(repo, "src/Svc.java")!;
      const names = _class_methods((await makeCtx(rd[0], rd[1]))!, "Svc").map((m) => m[0]).sort();
      expect(names).toEqual(["getItems", "loadBooking"]);   // method names — NOT BookingData/SubList, and no constructor
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("Java interface methods are named by the method (return-typed signatures)", async () => {
    if (!available()) return;
    const repo = mkdtempSync(join(tmpdir(), "cmn-i-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "IBooking.java"),
        `package a;\npublic interface IBooking {\n  Booking createBooking(User u);\n  void cancel(int id);\n}\n`);
      const rd = _read(repo, "src/IBooking.java")!;
      const names = _type_methods((await makeCtx(rd[0], rd[1]))!, "IBooking").map((m) => m[0]).sort();
      expect(names).toEqual(["cancel", "createBooking"]);   // NOT Booking/void
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

// REGRESSION: the DOWN footprint of a CLASS/INTERFACE anchor surfaces its OWN methods — not the method
// RETURN TYPES the same-package _TYPE_REF pass would otherwise sweep up. Before this, `BookingsBean`'s down
// spine read `BookingData / SubList / User` (the return types) instead of `loadBooking / getItems / …`.
describe("DOWN footprint of a class/interface decomposes into its methods, not return types", () => {
  test("Java class: down-deps are its methods (loadBooking/getItems), constructor excluded, NO return-type DTOs", async () => {
    if (!available()) return;
    const repo = mkdtempSync(join(tmpdir(), "down-cls-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "BookingsBean.java"),
        `package a;\npublic class BookingsBean {\n  public BookingData loadBooking(int id){ return repo.find(id); }\n  public SubList getItems(){ return l.sub(); }\n  public BookingsBean(){}\n}\n`);
      writeFileSync(join(repo, "src", "BookingData.java"), `package a;\npublic class BookingData { public int id; }\n`);
      writeFileSync(join(repo, "src", "SubList.java"), `package a;\npublic class SubList { }\n`);
      const g: any = await build_footprint(repo, "src/BookingsBean.java", "BookingsBean", { direction: "down", dataCoupling: false });
      const syms = g.nodes.filter((n: any) => n.id !== "n1").map((n: any) => n.symbol).sort();
      expect(syms).toEqual(["getItems", "loadBooking"]);              // the methods — NOT BookingData/SubList, NO constructor
      expect(g.nodes.filter((n: any) => n.id !== "n1").every((n: any) => n.kind === "method" && n.enclosing === "BookingsBean")).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("Java interface: down-deps are its method signatures (createBooking/cancel), NOT Booking/void", async () => {
    if (!available()) return;
    const repo = mkdtempSync(join(tmpdir(), "down-ifc-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "IBooking.java"),
        `package a;\npublic interface IBooking {\n  Booking createBooking(User u);\n  void cancel(int id);\n}\n`);
      const g: any = await build_footprint(repo, "src/IBooking.java", "IBooking", { direction: "down", dataCoupling: false });
      const syms = g.nodes.filter((n: any) => n.id !== "n1").map((n: any) => n.symbol).sort();
      expect(syms).toEqual(["cancel", "createBooking"]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
