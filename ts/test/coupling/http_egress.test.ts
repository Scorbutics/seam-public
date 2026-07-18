// EXTERNAL HTTP EGRESS (the "hot point") — an outbound call to an absolute external URL is a TERMINAL boundary the
// flow leaves the system through. The adapter is deliberately framework-AGNOSTIC and cross-language: it grounds on
// two universal primitives — an absolute URL literal (host present) in CALL-ARGUMENT position — never an HTTP-client
// API name. This pins that (a) egresses ground across languages, (b) a URL in an assignment/namespace/annotation is
// NOT an egress (excludes XML/RDF namespace URIs), (c) a relative path stays a route, not an egress, and (d) a
// producer-only egress survives grounding (no complement required — it is self-grounded by its host).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan_file_keys, TERMINAL_KINDS } from "../../src/codebase/coupling/adapters/index.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";
import { validateMatcher, runMatcher } from "../../src/codebase/coupling/key_ir.js";

const egress = (src: string, file = "a.java"): string[] => scan_file_keys(file, src).filter((k) => k.kind === "egress").map((k) => k.value);

describe("http-egress adapter — a universal, cross-language, framework-agnostic external-URL hot point", () => {
  test("an absolute URL in call-argument position grounds as an egress keyed by host (any language)", () => {
    expect(egress(`client.target("https://graph.microsoft.com/v1.0/bookings").post(x);`)).toEqual(["graph.microsoft.com"]);
    expect(egress(`Net::HTTP.post(URI("https://api.xplan.com/v2/export"), body)`, "a.rb")).toEqual(["api.xplan.com"]);
    expect(egress(`requests.post("https://hooks.slack.com/services/T/B/X", json=payload)`, "a.py")).toEqual(["hooks.slack.com"]);
    expect(egress(`fetch("https://stripe.com/v1/charges")`, "a.ts")).toEqual(["stripe.com"]);
  });

  test("a URL that is NOT a call argument (assignment / annotation / namespace) is NOT an egress", () => {
    expect(egress(`String NS = "http://www.w3.org/2001/XMLSchema";`)).toEqual([]);          // constant
    expect(egress(`@WebService(targetNamespace = "http://example.com/ns")`)).toEqual([]);   // annotation attribute
    expect(egress(`private String base = "https://api.xplan.com";`)).toEqual([]);           // field assignment
  });

  test("a relative path is a route, not an egress (no host)", () => {
    expect(egress(`fetch("/api/booking/create")`, "a.ts")).toEqual([]);
  });

  test("end-to-end: a producer-only egress survives grounding with no complement (self-grounded by host)", async () => {
    if (!available()) return;   // needs tree-sitter
    const repo = join(tmpdir(), "seam-egress-" + process.pid);
    const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };
    w("bean/EgBookingsBean.java", `package app;\npublic class EgBookingsBean {\n  private EgMsBean egMsBean;\n  public void egCreate(String m){ egMsBean.egCreateMs(m); }\n}\n`);
    w("bean/EgMsBean.java", `package app;\nimport javax.ws.rs.client.*;\npublic class EgMsBean {\n  public void egCreateMs(String m){\n    Client c = ClientBuilder.newClient();\n    c.target("https://graph.microsoft.com/v1.0/bookings").request().post(Entity.json(m));\n  }\n}\n`);
    try {
      const [data]: any = await grow_to_terminals(repo, "bean/EgBookingsBean.java", "egCreate", { maxSteps: 30, maxNodes: 80, dataCoupling: true } as any);
      const byId = new Map<string, any>(data.nodes.map((n: any) => [n.id, n]));
      // the external host is a grounded egress boundary node…
      const egressNode = data.nodes.find((n: any) => n.kind === "egress" && String(n.symbol).includes("graph.microsoft.com"));
      expect(egressNode).toBeDefined();
      // …and the code that calls out is wired to it with a produce edge, even though there is NO consumer.
      const call = (data.edges as any[]).find((e) => e.kind === "egress-call" && e.to === egressNode.id);
      expect(call).toBeDefined();
      expect(byId.get(call.from)?.symbol).toBe("egCreateMs");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }, 30000);
});

// FLYWHEEL VOCABULARY (increment 3) — the coupling flywheel clusters floor-blind hot points into ONE general
// matcher rule (cached, low LLM), the way it already does for JMS queues. `egress` must be in its vocabulary so
// it can LEARN a non-URL / SDK external-call pattern the URL-literal floor misses — as a TERMINAL rule (produces,
// no consumer) that self-grounds. This pins the deterministic half: a learned egress matcher validates, extracts
// its key, and its kind is terminal (grounds without a complement). The LLM synthesis itself is exercised online.
describe("flywheel vocabulary — a learned egress matcher is valid, terminal, and extractable", () => {
  test("a `call` egress rule validates (kind stays egress, not coerced to http-route) and extracts its key", async () => {
    const m = validateMatcher({ via: "call", token: "exchange", argIndex: 0, kind: "egress", role: "produces", name: "rt-egress" });
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("egress");        // NOT aliased to http-route (that alias is only for a bare http/url/route/path kind)
    expect(m!.role).toBe("produces");      // terminal — always a producer
    const hits = await runMatcher(m!, "C.java", 'restTemplate.exchange("https://api.xplan.com/v2", GET, req, R.class);');
    expect(hits[0]?.kind).toBe("egress");
    expect(hits[0]?.produces).toBe(true);
  });
  test("egress is a TERMINAL kind (registry-sourced) → grounds from the producer alone, no complement", () => {
    expect(TERMINAL_KINDS.has("egress")).toBe(true);
  });
});
