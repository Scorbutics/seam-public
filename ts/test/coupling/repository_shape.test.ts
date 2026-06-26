// The `repository` matcher IR shape — `<token>.<verb>()` where the RECEIVER ITSELF is the table (the 2-part
// counterpart of `member`: there the key is the member between receiver and verb; here the receiver is the
// key). Synthesised by the receiver-classifier for a database-classified 2-part repository (`users.create()`,
// `featuresRepository.set…()`) — the layer member_access (3-part) can't see. Role fixed per rule.
import { describe, expect, test } from "bun:test";
import { validateMatcher, runMatcher } from "../../src/codebase/coupling/key_ir.js";

describe("repository matcher shape (receiver = table)", () => {
  const read = validateMatcher({ via: "repository", token: "userRepository", verbs: ["findMany", "get"], kind: "db-table", role: "consumes" });
  const write = validateMatcher({ via: "repository", token: "userRepository", verbs: ["create", "deleteByEmail"], kind: "db-table", role: "produces" });

  test("validates: bare token + ≥1 verb; rejects a dotted token or empty verbs", () => {
    expect(read?.via).toBe("repository");
    expect((read as any).token).toBe("userRepository");
    expect(validateMatcher({ via: "repository", token: "a.b", verbs: ["get"], kind: "db-table", role: "consumes" })).toBeNull();
    expect(validateMatcher({ via: "repository", token: "repo", verbs: [], kind: "db-table", role: "consumes" })).toBeNull();
  });

  test("the RECEIVER is the key; role comes from the verb set; a path prefix is allowed", async () => {
    const code = `
      await userRepository.create({ data });
      const u = await userRepository.findMany();
      await this.userRepository.deleteByEmail(email);   // path prefix → still userRepository
      other.thing.run();                                 // different receiver → ignored
      userRepository.map(x => x);                         // a verb NOT in the rule → ignored
    `;
    const r = (await runMatcher(read!, "x.ts", code)).map((h) => `${h.value}:${h.produces ? "P" : "C"}`);
    const w = (await runMatcher(write!, "x.ts", code)).map((h) => `${h.value}:${h.produces ? "P" : "C"}`);
    expect(r).toEqual(["userRepository:C"]);                        // findMany → consumes (the receiver is the key)
    expect(w.sort()).toEqual(["userRepository:P", "userRepository:P"]);   // create + deleteByEmail → produces
  });
});

describe("channel matcher shape (receiver-scoped string key)", () => {
  const emit = validateMatcher({ via: "channel", token: "bus", verbs: ["emit", "publish"], kind: "event", role: "produces" });
  const on = validateMatcher({ via: "channel", token: "bus", verbs: ["on", "subscribe"], kind: "event", role: "consumes" });

  test("the STRING-LITERAL arg is the key; scoped to the receiver (no generic .emit elsewhere)", async () => {
    const code = `
      bus.emit('orders.sync', payload);
      bus.on('orders.sync', handler);
      this.bus.publish('user.created');     // path prefix → still bus
      other.emit('ignored');                // different receiver → ignored
    `;
    const p = (await runMatcher(emit!, "x.ts", code)).map((h) => `${h.value}:${h.produces ? "P" : "C"}`).sort();
    const c = (await runMatcher(on!, "x.ts", code)).map((h) => `${h.value}:${h.produces ? "P" : "C"}`).sort();
    expect(p).toEqual(["orders.sync:P", "user.created:P"]);   // emit/publish on bus → produces
    expect(c).toEqual(["orders.sync:C"]);                      // on → consumes
  });
});
