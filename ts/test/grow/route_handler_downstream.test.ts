// Crossing a route INTO its handler's DOWNSTREAM mechanism. When the anchor is on the UI side, the grow
// crosses the HTTP route into the backend handler — and must then keep going DOWNSTREAM into what the
// handler delegates to (its @Inject'd bean), even across a Maven-module boundary. A handler's in-repo
// callers are just the framework (empty), so an upstream-only crossing dead-ended at the service.
//
// Two layers:
//   1. STRUCTURAL — the route adapter declares `handlerEdge` (its far side is a downstream handler);
//      data adapters (db-table) do NOT (their reader continues UPSTREAM toward where it's displayed).
//   2. BEHAVIOURAL — anchored on the JS UI, grow_to_terminals reaches the bean in the other module.
// Hermetic: a throwaway git repo mirroring acme/{web-manage,ejb}. The grow gates on tree-sitter.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kindOf } from "../helpers/coupling.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { available } from "../../src/codebase/atoms.js";

describe("handlerEdge is structural (registry, not a heuristic)", () => {
  test("the http-route adapter marks its server side as the handler edge", () => {
    expect(kindOf("http-route").handlerEdge).toBe("route-serve");   // crossing INTO route-serve ⇒ explore downstream
  });
  test("a data adapter (db-table) has NO handlerEdge — its reader continues UPSTREAM toward display", () => {
    expect(kindOf("db-table").handlerEdge).toBeUndefined();
  });
});

describe("UI anchor crosses the route into the handler and reaches its bean", () => {
  const REPO = join(tmpdir(), "seam-handler-down-" + process.pid);
  const git = (...a: string[]) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf-8" });
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    mkdirSync(REPO, { recursive: true });
    git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
    // web-manage: JS UI fetches a REST route served by a JAX-RS handler in the SAME module…
    write("web-manage/js/fileNoteItem.js",
      "export function generateFileNote(id, audit) {\n  return $http.put('/manage/rest/fileNote/generateFileNote/' + id, audit);\n}\n");
    write("web-manage/com/x/svc/FileNoteService.java",
      'package com.x.svc;\nimport com.x.bean.FileNoteItemBean;\nimport javax.inject.Inject;\n@Path("fileNote")\npublic class FileNoteService {\n  @Inject private FileNoteItemBean mFileNoteItemBean;\n  @PUT @Path("generateFileNote/{id}")\n  public Response generateFileNote(@PathParam("id") String id, Map audit) {\n    final Map toReturn = mFileNoteItemBean.generateFileNote(id, audit);\n    return Response.ok(toReturn).build();\n  }\n}\n');
    // …whose @Inject'd bean lives in a SEPARATE Maven module (different dir + package).
    write("ejb/com/x/bean/FileNoteItemBean.java",
      "package com.x.bean;\nimport javax.enterprise.context.ApplicationScoped;\n@ApplicationScoped\npublic class FileNoteItemBean {\n  public Map generateFileNote(String id, Map audit) { return null; }\n}\n");
    git("add", "-A");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the EJB bean (separate module) is in the footprint, reached downstream of the handler", async () => {
    if (!available()) return;   // no tree-sitter → no complement units to cross into
    const [data] = await grow_to_terminals(REPO, "web-manage/js/fileNoteItem.js", "generateFileNote",
      { bidirectional: true, dataCoupling: true, intent: "generate file note via XPLAN ESB" });
    const bean = (data.nodes ?? []).find((n: any) => n.file?.endsWith("ejb/com/x/bean/FileNoteItemBean.java"));
    expect(bean).toBeDefined();
    // the handler complement (in the service file, reached across the route) must be tagged for DOWNSTREAM
    // expansion — that's the tag whose loss stranded the bean (clobbered to "forward" before the fix).
    const handler = (data.nodes ?? []).find((n: any) => n.coupling && n.file?.endsWith("FileNoteService.java") && n.direction === "backward");
    expect(handler).toBeDefined();
  });
});
