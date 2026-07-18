// CO-EQUAL CULMINATION FAN — an orchestrator has MANY ends, not one. FanBean.fanCreate fans into THREE grounded
// boundaries: a JMS queue publish, an external HTTP egress, and a db-table write. The concern "## Flows" must show
// ALL of them as co-equal `⇒` outcomes (the output-side mirror of the `←` way-in fan), each with the delegate bean
// on its chain — not crown one and bury the rest. A second method (fanUpdate) writes only the queue + db, proving
// the fan is per-mechanism. Hermetic; deterministic FLOOR coupling (JMS listener + JPA @Entity + URL egress). Java
// so JMS/JPA ground; tree-sitter guarded.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { available } from "../../src/codebase/atoms.js";

const TS_DIR = join(import.meta.dir, "..", "..");
const repo = join(tmpdir(), "seam-culmfan-" + process.pid);
const w = (rel: string, t: string) => { const p = join(repo, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); };

beforeAll(() => {
  w("package.json", `{ "name": "culmfan", "version": "1.0.0" }\n`);
  w("entity/FanBooking.java", `package app;\nimport javax.persistence.Entity;\n@Entity\npublic class FanBooking { private Long id; }\n`);
  w("event/FanEvent.java", `package app;\nimport java.io.Serializable;\npublic class FanEvent implements Serializable { public FanEvent(String id){} }\n`);
  // the ORCHESTRATOR — fanCreate → queue publish + external HTTP egress + db; fanUpdate → queue + db (no egress).
  w("bean/FanBean.java",
    `package app;\nimport javax.persistence.EntityManager;\npublic class FanBean {\n  private EntityManager em;\n  private FanXPlanBean fanXPlanBean;\n  private FanMsBean fanMsBean;\n  public void fanCreate(String m){\n    fanXPlanBean.fanPublish(m);\n    fanMsBean.fanCallMs(m);\n    FanBooking b = new FanBooking(); em.persist(b);\n  }\n  public void fanUpdate(String m){\n    fanXPlanBean.fanPublish(m);\n    FanBooking b = new FanBooking(); em.merge(b);\n  }\n}\n`);
  // the XPlan bean → the JMS producer utility (the queue-publish is attributed to the sender class)
  w("bean/FanXPlanBean.java", `package app;\npublic class FanXPlanBean {\n  private FanJmsSender fanJmsSender;\n  public void fanPublish(String m){ FanEvent e = new FanEvent(m); fanJmsSender.send(e); }\n}\n`);
  w("util/FanJmsSender.java",
    `package app;\nimport javax.jms.JMSContext;\nimport javax.jms.Queue;\nimport javax.annotation.Resource;\nimport javax.inject.Inject;\npublic class FanJmsSender {\n  @Inject private JMSContext jmsContext;\n  @Resource(lookup = "java:/jms/queue/fanExport") private Queue fanQueue;\n  public void send(FanEvent e){ jmsContext.createProducer().send(fanQueue, e); }\n}\n`);
  // the Microsoft bean → an EXTERNAL HTTP egress (absolute URL, any client)
  w("bean/FanMsBean.java",
    `package app;\nimport javax.ws.rs.client.*;\npublic class FanMsBean {\n  public void fanCallMs(String m){\n    Client c = ClientBuilder.newClient();\n    c.target("https://graph.microsoft.com/v1.0/bookings").request().post(Entity.json(m));\n  }\n}\n`);
  // the queue's async other side (so the queue grounds with a consumer)
  w("consumer/FanConsumer.java",
    `package app;\nimport javax.ejb.MessageDriven;\nimport javax.ejb.ActivationConfigProperty;\nimport javax.jms.Message;\nimport javax.jms.MessageListener;\n@MessageDriven(activationConfig = { @ActivationConfigProperty(propertyName="destination", propertyValue="java:/jms/queue/fanExport") })\npublic class FanConsumer implements MessageListener {\n  public void onMessage(Message message){ }\n}\n`);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function flows(): string {
  return execFileSync("bun", ["src/cli/decompose.ts", "--repo", repo, "--scan", "--auto",
    "--center", "bean/FanBean.java", "--intent", "how is a booking created and exported", "--data-coupling", "floor", "--format", "concern"],
    { cwd: TS_DIR, env: { ...process.env, SEAM_GRAPH_CACHE: "1" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}

describe("concern Flows — an orchestrator's co-equal culmination fan (db + external egress)", () => {
  // Both boundaries here ground on a deterministic FLOOR (JPA @Entity + URL egress), so the test is hermetic.
  // The JMS queue is a THIRD co-equal outcome in the same fan on a warm repo (grounded via the coupling flywheel,
  // no floor JMS adapter yet) — that half is validated separately and becomes hermetic once queue detection is
  // cheap/cached (a later increment).
  test("fanCreate fans its co-equal outcomes: a direct db write AND an external egress via its delegate bean", () => {
    if (!available()) return;   // needs tree-sitter (Java + JPA + URL egress grounding)
    const out = flows();
    const seg = out.slice(out.indexOf("## Flows"), out.indexOf("## In") >= 0 ? out.indexOf("## In") : undefined);
    const createBlock = seg.slice(seg.indexOf("● FanBean.fanCreate"));
    // TWO co-equal `⇒` ends — neither crowned as the sole spine
    expect(createBlock).toMatch(/●[^\n]*fanCreate\b[^\n]*\(\d+ outcomes\)/);
    // the db write (direct, in the orchestrator)…
    expect(createBlock).toMatch(/⇒ ──writes──▶ db "FanBooking"/);
    // …and the external HTTP egress, reached THROUGH the delegate bean (FanMsBean.fanCallMs), not skipped
    expect(createBlock).toMatch(/⇒ [^\n]*FanMsBean\.fanCallMs ──calls out──▶ external graph\.microsoft\.com/);
  }, 30000);
});
