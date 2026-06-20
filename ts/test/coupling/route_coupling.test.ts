// Cross-stack HTTP-route coupling (the AngularJS-$http ⇄ Java-@WebServlet case): the deterministic
// floor must (1) read a route from an ANNOTATION string-literal on the handler side, agnostically —
// @WebServlet / @GetMapping / Flask @app.route, keyed on the SHAPE `@name("/path")`, not the name;
// (2) read the caller side incl. AngularJS `$http`; (3) couple them across a context-path prefix +
// `/*` wildcard via whole-segment suffix matching, so a servlet anchored alone (container-invoked,
// "no usages") still reaches the front-end controller that calls it. Hermetic — throwaway tmp repo.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan_file_keys } from "../../src/codebase/coupling/index.js";
import { build_class_graph } from "../../src/codebase/scan/class_graph.js";
import { build_module_graph } from "../../src/codebase/scan/module_graph.js";
import { build_consumers_graph } from "../../src/codebase/scan/consumers_graph.js";
import { available } from "../../src/codebase/atoms.js";

const keys = (file: string, text: string) => scan_file_keys(file, text);

describe("annotation-route adapter (handler side, agnostic)", () => {
  test("@WebServlet path literal → produced http-route", () => {
    const hits = keys("X.java", '@WebServlet("/document/*")\npublic class X {}');
    expect(hits).toContainEqual({ kind: "http-route", value: "/document/*", line: 0, produces: true });
  });
  test("Spring @GetMapping with a path param normalises to a wildcard", () => {
    const hits = keys("C.java", '@GetMapping("/owners/{id}")\nvoid get() {}');
    expect(hits).toContainEqual({ kind: "http-route", value: "/owners/*", line: 0, produces: true });
  });
  test("Flask @app.route decorator (Python) is caught by the same shape", () => {
    const hits = keys("v.py", '@app.route("/api/members")\ndef members(): pass');
    expect(hits.some((h) => h.kind === "http-route" && h.value === "/api/members" && h.produces)).toBe(true);
  });
  test("a non-route annotation (no leading-slash literal) is NOT a route", () => {
    expect(keys("X.java", '@Roles(group = RoleGroup.CAN_VIEW)\npublic class X {}')).toEqual([]);
    expect(keys("X.java", "@Override\nvoid f() {}")).toEqual([]);
  });
});

describe("caller side ($http / fetch — framework-agnostic)", () => {
  const callerVal = (code: string) => keys("c.js", code).filter((h) => h.kind === "http-route" && !h.produces).map((h) => h.value);
  test("AngularJS $http.get path literal → consumed http-route", () => {
    expect(callerVal("$http.get('/manage/rest/member/document/' + id)")).toContain("/manage/rest/member/document");
  });
  // React/Vue share the same HTTP libraries — no framework-specific API needed for the common cases.
  test("React fetch / axios.get / ky / template literal", () => {
    expect(callerVal('fetch("/api/users")')).toContain("/api/users");
    expect(callerVal('axios.get(`/api/users/${id}`)')).toContain("/api/users/*");
    expect(callerVal('ky.post("/api/orders")')).toContain("/api/orders");
  });
  test("Vue vue-resource this.$http and Nuxt useFetch / $fetch", () => {
    expect(callerVal('this.$http.get("/api/members")')).toContain("/api/members");
    expect(callerVal('const {data} = useFetch("/api/members")')).toContain("/api/members");
    expect(callerVal('$fetch("/api/members")')).toContain("/api/members");
  });
  test("an Express route DEFINITION (router.get) is NOT mistaken for a caller", () => {
    // `get` is not a recognised caller API, so a server-side route definition stays out of the caller set
    expect(keys("c.js", 'router.get("/users", handler)').filter((h) => !h.produces)).toEqual([]);
  });
});

// (LLM-key fallback gating — floor-covered files cost no LLM — is now exercised in key_augment.test.ts,
// where the repo-wide batched llm_key_index lives.)

describe("cross-stack coupling: servlet anchor reaches the AngularJS caller", () => {
  const REPO = join(tmpdir(), "seam-route-test-" + process.pid);
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    write("frontend/memberDocCtrl.js",
      "angular.module('app').controller('memberDocumentVaultDocuSignController',\n" +
      "  ['$scope', '$http', function ($scope, $http) {\n" +
      "    $scope.refresh = function (id) {\n" +
      "      $http.get('/manage/rest/member/document/' + id).then(function (r) { $scope.doc = r.data; });\n" +
      "    };\n}]);\n");
    write("backend/ManageDocumentVaultServlet.java",
      "package com.acme.servlet.http;\n" +
      '@WebServlet("/document/*")\n' +
      "@Roles(group = RoleGroup.CAN_VIEW_MEMBERS)\n" +
      "public class ManageDocumentVaultServlet extends HttpServlet {\n" +
      "    protected void doGet(HttpServletRequest req, HttpServletResponse resp) { }\n}\n");
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("the route /document/* couples to the full-URL /manage/.../document caller", async () => {
    if (!available()) return;   // tree-sitter required to parse the class anchor
    const g = await build_class_graph(REPO, "backend/ManageDocumentVaultServlet.java", "ManageDocumentVaultServlet", { dataCoupling: true });
    const files = (g.nodes ?? []).map((n: any) => n.file);
    // the container-invoked servlet, alone, now reaches the front-end controller that calls its route
    expect(files.some((f: string) => f.endsWith("memberDocCtrl.js"))).toBe(true);
    // and a route boundary node was materialised (the served path)
    expect((g.nodes ?? []).some((n: any) => n.kind === "route" && String(n.symbol).includes("/document"))).toBe(true);
  });

  // The OTHER direction — the one a user actually anchors on. An AngularJS controller has no export and
  // no importer, and its $http call is inside an anonymous `.controller(...)` callback, so it used to
  // read as "1 core isolated". Both module mode (whole-file scan) and an unresolvable controller-name
  // "symbol" (range-less → whole-file fallback) must now reach the servlet.
  const reaches = (g: any, suffix: string) => (g.nodes ?? []).some((n: any) => String(n.file).endsWith(suffix));
  test("controller as MODULE anchor reaches the servlet", async () => {
    if (!available()) return;
    const g = await build_module_graph(REPO, "frontend/memberDocCtrl.js", { dataCoupling: true });
    expect(reaches(g, "ManageDocumentVaultServlet.java")).toBe(true);
  });
  test("controller-NAME as a (range-less) symbol anchor reaches the servlet via whole-file fallback", async () => {
    if (!available()) return;
    const g = await build_consumers_graph(REPO, "frontend/memberDocCtrl.js", "memberDocumentVaultDocuSignController", { dataCoupling: true });
    expect(reaches(g, "ManageDocumentVaultServlet.java")).toBe(true);
  });
});
