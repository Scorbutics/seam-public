// Shape router (cli/route.ts + the core's SHAPES registry) — the semantic front-end. The routing JUDGEMENT is an LLM pass, pinned here
// with a host-bus canned reply (keyed by the "shape-route" tag) so dispatch + name-resolution + the
// route-aways are deterministic and testable without a live model.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HostBus, set_host_bus } from "../../src/core/llm.js";
import { ask, routeQuestion, resolveName, shapeIds } from "../../src/cli/route.js";

const repo = join("test", "fixtures", "class-repo");
const withReply = async <T>(reply: string, fn: () => Promise<T>): Promise<T> => {
  set_host_bus(new HostBus({ "shape-route": reply }));
  try { return await fn(); } finally { set_host_bus(null); }
};

describe("routeQuestion", () => {
  test("parses the LLM decision (id = shape) + extracted targets", async () => {
    const d = await withReply('[{"id":"compare","target":"checkout","target2":"admin","reason":"diff"}]',
      () => routeQuestion(repo, "how do checkout and admin differ?"));
    expect(d).toEqual({ shape: "compare", target: "checkout", target2: "admin", reason: "diff" });
  });
  test("rejects an unknown shape id", async () => {
    const d = await withReply('[{"id":"banana","target":"x"}]', () => routeQuestion(repo, "?"));
    expect(d).toBeNull();
  });
});

describe("resolveName (deterministic def lookup)", () => {
  test("resolves a symbol to its definition file", async () => {
    const r = await resolveName(repo, "checkout");
    expect(r?.file).toBe("src/checkout.ts");
  });
  test("returns null for a name with no definition", async () => {
    expect(await resolveName(repo, "totallyNotARealSymbol")).toBeNull();
  });
});

describe("ask: route → resolve → run", () => {
  test("a callers question runs the consumers SET shape", async () => {
    const r = await withReply('[{"id":"consumers","target":"checkout","reason":"callers"}]',
      () => ask(repo, "who calls checkout?"));
    expect(r.shape).toBe("consumers");
    expect(r.result.shape).toBe("set");
  });
  test("a difference question runs the comparison shape with both anchors resolved", async () => {
    const r = await withReply('[{"id":"compare","target":"checkout","target2":"admin","reason":"diff"}]',
      () => ask(repo, "how does checkout differ from admin?"));
    expect(r.shape).toBe("compare");
    expect(r.result.shape).toBe("comparison");
    expect(r.result.shared.map((d: any) => d.symbol)).toEqual(["PaymentService"]);
  });
  test("a 'what does X depend on' question runs the dependencies shape", async () => {
    const r = await withReply('[{"id":"dependencies","target":"checkout","reason":"deps"}]',
      () => ask(repo, "what does checkout depend on?"));
    expect(r.shape).toBe("dependencies");
    expect(r.result.shape).toBe("deps");
    expect(r.result.members.map((d: any) => d.symbol)).toEqual(["PaymentService"]);
  });
  test("a lexical question routes AWAY to grep (honest negative, no structural result)", async () => {
    const r = await withReply('[{"id":"grep","target":"","reason":"lexical"}]', () => ask(repo, "where is the string TODO?"));
    expect(r.shape).toBe("grep");
    expect(r.routedAway).toBe(true);
    expect(r.result).toBeUndefined();
  });
  test("a semantic question routes AWAY to rag", async () => {
    const r = await withReply('[{"id":"rag","target":"","reason":"meaning"}]', () => ask(repo, "what code is about payments?"));
    expect(r.shape).toBe("rag");
    expect(r.routedAway).toBe(true);
  });
  test("a routed shape whose target can't be resolved reports guidance, not a wrong answer", async () => {
    const r = await withReply('[{"id":"consumers","target":"ghostSymbol","reason":"callers"}]', () => ask(repo, "who calls ghostSymbol?"));
    expect(r.shape).toBe("consumers");
    expect(r.result).toBeUndefined();
    expect(r.guidance).toContain("doesn't resolve");
  });
});

describe("registry is the source of truth", () => {
  test("every structural shape the router can pick is in the core registry", async () => {
    const ids = await shapeIds();
    for (const id of ["consumers", "dependencies", "reaches", "contract", "neighborhood", "compare", "flow"])
      expect(ids).toContain(id);
  });
});
