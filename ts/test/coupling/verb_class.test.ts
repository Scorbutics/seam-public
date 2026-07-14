// Framework-agnostic data-access verb classification (the floor / offline degradation that replaced the hardcoded
// ORM-API verb list). dataRole = distinctive read/write (generic verbs → null, precision); writeOp = the genesis-
// vs-mutation op-class (ambiguous verbs → null → the flywheel decides).
import { describe, expect, test } from "bun:test";
import { dataRole, writeOp } from "../../src/codebase/coupling/verb_class.js";

describe("verb_class (naming-convention floor)", () => {
  test("dataRole: distinctive data verbs classify; generic verbs are excluded (precision)", () => {
    // the old exact ORM list, now covered by PREFIX convention…
    for (const v of ["create", "createMany", "insert", "update", "updateMany", "upsert", "delete", "deleteMany", "remove", "destroy", "save"]) expect(dataRole(v)).toBe("write");
    for (const v of ["findUnique", "findMany", "findFirst", "count", "aggregate", "groupBy", "query"]) expect(dataRole(v)).toBe("read");
    // …and now GENERALISES to custom verbs the exact list missed
    expect(dataRole("deleteByEmail")).toBe("write");
    expect(dataRole("createManyAndReturn")).toBe("write");
    expect(dataRole("findActiveByTenant")).toBe("read");
    // generic / opaque verbs are NOT a distinctive data access → null (dropped by the floor)
    for (const v of ["get", "set", "add", "list", "fetch", "load", "select", "map", "then", "toString", "handle", "run", "process"]) expect(dataRole(v)).toBeNull();
  });

  test("writeOp: create (genesis) vs update/delete (mutation); ambiguous → null (flywheel decides)", () => {
    for (const v of ["create", "createMany", "insert", "register"]) expect(writeOp(v)).toBe("create");
    for (const v of ["update", "updateMany", "patch", "modify", "edit"]) expect(writeOp(v)).toBe("update");
    for (const v of ["delete", "deleteMany", "remove", "destroy", "purge"]) expect(writeOp(v)).toBe("delete");
    // genuinely create-OR-update verbs → null (offline degrades to relevance; the flywheel classifies them)
    for (const v of ["save", "upsert", "persist", "store"]) expect(writeOp(v)).toBeNull();
  });
});
