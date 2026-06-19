// Contract test for the Java deterministic floor (src/core/resolve/languages/java.ts): the import
// parser + the FQN→file resolver, and that the registry dispatches .java through it. Hermetic — a
// throwaway tmp repo, no LSP, no network.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { imports, floor_resolve } from "../../src/languages/java/resolve.js";
import { provider_for, parse_imports } from "../../src/core/resolve/languages/index.js";

const REPO = join(tmpdir(), "seam-java-test-" + process.pid);
const src = (p: string) => join(REPO, "src/main/java", p);
const write = (rel: string, text: string) => { mkdirSync(join(src(rel), ".."), { recursive: true }); writeFileSync(src(rel), text); };

beforeAll(() => {
  rmSync(REPO, { recursive: true, force: true });
  write("com/x/app/Service.java", "package com.x.app;\nimport com.x.domain.Repo;\npublic class Service {}\n");
  write("com/x/app/Helper.java", "package com.x.app;\npublic class Helper {}\n");   // same-package sibling of Service
  write("com/x/app/Wild.java", "package com.x.app;\nimport com.x.domain.*;\npublic class Wild {}\n");   // wildcard-imports com.x.domain
  write("com/x/domain/Repo.java", "package com.x.domain;\npublic class Repo {\n  public static class Inner {}\n}\n");
  write("com/x/domain/Const.java", "package com.x.domain;\npublic class Const { public static final int N = 1; }\n");
});
afterAll(() => rmSync(REPO, { recursive: true, force: true }));

describe("java import parser", () => {
  const refs = () => imports(
    "package com.x.app;\n" +
    "import com.x.domain.Repo;\n" +
    "import static com.x.domain.Const.N;\n" +
    "import com.x.domain.*;\n" +          // wildcard — skipped
    "import java.util.List;\n" +
    "public class Service {}\n");

  test("parses class import: simple name + FQN source", () => {
    const r = refs().find((x) => x.source === "com.x.domain.Repo");
    expect(r).toBeTruthy();
    expect(r!.name).toBe("Repo");
    expect(r!.local).toBe("Repo");
  });

  test("parses static-member import (FQN kept for resolve)", () => {
    expect(refs().some((x) => x.source === "com.x.domain.Const.N")).toBe(true);
  });

  test("skips wildcard imports (no single target file)", () => {
    expect(refs().some((x) => x.source?.endsWith(".*"))).toBe(false);
  });

  test("captures external imports too (resolver decides they're unresolvable)", () => {
    expect(refs().some((x) => x.source === "java.util.List")).toBe(true);
  });
});

describe("java FQN→file resolver", () => {
  test("resolves a cross-package import to its file", () => {
    expect(floor_resolve(REPO, src("com/x/app/Service.java"), "com.x.domain.Repo")?.replace(/\\/g, "/"))
      .toBe("src/main/java/com/x/domain/Repo.java");
  });

  test("nested-class import resolves to the enclosing type's file", () => {
    expect(floor_resolve(REPO, src("com/x/app/Service.java"), "com.x.domain.Repo.Inner")?.replace(/\\/g, "/"))
      .toBe("src/main/java/com/x/domain/Repo.java");
  });

  test("static-member import resolves to the type's file", () => {
    expect(floor_resolve(REPO, src("com/x/app/Service.java"), "com.x.domain.Const.N")?.replace(/\\/g, "/"))
      .toBe("src/main/java/com/x/domain/Const.java");
  });

  test("external / unknown FQN → null", () => {
    expect(floor_resolve(REPO, src("com/x/app/Service.java"), "java.util.List")).toBeNull();
  });

  // SAME-PACKAGE: a bare type name (no import) resolves to a sibling in the importing file's package —
  // the flat-package case (spring-petclinic's controller→repository in one `owner` package).
  test("bare type name resolves to a same-package sibling", () => {
    expect(floor_resolve(REPO, src("com/x/app/Service.java"), "Helper")?.replace(/\\/g, "/"))
      .toBe("src/main/java/com/x/app/Helper.java");
  });

  test("bare type name with no same-package sibling and no wildcard → null (not a cross-package guess)", () => {
    expect(floor_resolve(REPO, src("com/x/app/Service.java"), "Repo")).toBeNull();   // Repo is in com.x.domain; Service neither same-packages nor wildcard-imports it
    expect(floor_resolve(REPO, src("com/x/app/Service.java"), "Nonexistent")).toBeNull();
  });

  // WILDCARD: `import a.b.*;` makes a.b's types visible by bare name (no per-type import line).
  test("bare type resolves via a wildcard import (import a.b.*;)", () => {
    expect(floor_resolve(REPO, src("com/x/app/Wild.java"), "Repo")?.replace(/\\/g, "/"))
      .toBe("src/main/java/com/x/domain/Repo.java");
  });

  test("wildcard import doesn't resolve a type absent from the imported package", () => {
    expect(floor_resolve(REPO, src("com/x/app/Wild.java"), "Nonexistent")).toBeNull();
  });
});

describe("registry wiring", () => {
  test("provider_for(.java) is the java provider with a floor + parser", () => {
    const p = provider_for("X.java");
    expect(p?.name).toBe("java");
    expect(typeof p?.resolve).toBe("function");
    expect(typeof p?.imports).toBe("function");
  });

  test("parse_imports dispatches .java through the java parser", () => {
    expect(parse_imports("X.java", "import com.x.domain.Repo;\n").some((r) => r.source === "com.x.domain.Repo")).toBe(true);
  });
});
