// AngularJS $scope ⇄ template binding is NO LONGER a built-in adapter (ng_scope was deleted — too
// framework-specific). It is now a LEARNED adapter: the flywheel synthesizes `assign` ($scope.x = fn) +
// `attr` (ng-* call) matcher rules and caches them to `.seam/key-matchers.json`; from then on they apply
// DETERMINISTICALLY, offline, with no LLM (llmKeyIndex proceeds when hasMatcherCache, even without --llm).
// This test PRIMES that cache (simulating a prior warm-up) and proves the end-to-end capability ng_scope
// used to give is preserved: a footprint anchored in the controller reaches the template AND the JAX-RS
// backend through the shared method NAME. The shape-level golden equivalence lives in key_ir_shapes.test.ts.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build_module_graph } from "../../src/codebase/scan/module_graph.js";
import { build_consumers_graph } from "../../src/codebase/scan/consumers_graph.js";
import { grow_to_terminals } from "../../src/codebase/grow/orchestrate.js";
import { _resetMatcherCacheMem } from "../../src/codebase/coupling/key_store.js";
import { available } from "../../src/codebase/atoms.js";

// the two learned rules ng_scope became — what a warm `.seam/` holds after the flywheel learns AngularJS.
const NG_MATCHERS = {
  schema: 1,
  matchers: [
    { via: "assign", token: "$scope", kind: "binding", role: "produces", name: "ng-scope-method", description: "AngularJS $scope.method = function" },
    { via: "attr", directive: "ng-", keyFrom: "call", kind: "binding", role: "consumes", name: "ng-directive-call", description: "scope method called from an ng-* directive / interpolation" },
  ],
};
const reaches = (g: any, suffix: string) => (g.nodes ?? []).some((n: any) => String(n.file).endsWith(suffix));
const writeIn = (repo: string) => (rel: string, text: string) => { mkdirSync(join(repo, rel, ".."), { recursive: true }); writeFileSync(join(repo, rel), text); };
const primeMatchers = (repo: string) => { mkdirSync(join(repo, ".seam"), { recursive: true }); writeFileSync(join(repo, ".seam", "key-matchers.json"), JSON.stringify(NG_MATCHERS)); };

describe("learned AngularJS adapter (primed `.seam` cache) — controller → template → JAX-RS backend", () => {
  const REPO = join(tmpdir(), "seam-ng-learned-" + process.pid);
  const write = writeIn(REPO);
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    write("web/fileNoteItem.js",
      "angular.module('app').controller('FileNoteItemCtrl', function($scope, $http) {\n" +
      "  $scope.initFileNoteItem = function() { $scope.ready = true; };\n" +
      "  $scope.refreshSection = function() { $http.put('/manage/rest/fileNote/refreshSection/' + $scope.id, {}); };\n" +
      "});\n");
    write("web/fileNoteItem.html",
      '<div ng-init="initFileNoteItem()">\n  <button ng-click="refreshSection()">Refresh</button>\n</div>\n');
    write("src/FileNoteService.java",
      '@Path("fileNote")\npublic class FileNoteService {\n  @PUT\n  @Path("refreshSection/{id}")\n  public Response refreshSection(String id) { return ok(); }\n}\n');
    primeMatchers(REPO);
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("consumers mode: anchored on initFileNoteItem reaches the template AND the backend (no LLM, cached rules)", async () => {
    if (!available()) return;
    _resetMatcherCacheMem();
    const g = await build_consumers_graph(REPO, "web/fileNoteItem.js", "initFileNoteItem", { dataCoupling: true });
    expect(reaches(g, "fileNoteItem.html")).toBe(true);       // surfaced the learned $scope binding → crossed to the template
    expect(reaches(g, "FileNoteService.java")).toBe(true);    // sibling refreshSection → $http route → backend
  });
  test("module mode reaches the template + backend too", async () => {
    if (!available()) return;
    _resetMatcherCacheMem();
    const g = await build_module_graph(REPO, "web/fileNoteItem.js", { dataCoupling: true });
    expect(reaches(g, "fileNoteItem.html")).toBe(true);
    expect(reaches(g, "FileNoteService.java")).toBe(true);
  });
});

describe("learned AngularJS adapter — component fallback from an isolated leaf anchor", () => {
  const REPO = join(tmpdir(), "seam-ng-learned-fb-" + process.pid);
  const write = writeIn(REPO);
  beforeAll(() => {
    rmSync(REPO, { recursive: true, force: true });
    write("web/fileNoteItem.js",
      "angular.module('app').controller('FileNoteItemCtrl', function($scope, $http) {\n" +
      "  $scope.refreshSection = function() { $http.put('/manage/rest/fileNote/refreshSection/' + $scope.id, {}); };\n" +
      "  initFileNoteItem();\n" +
      "  function initFileNoteItem() { $scope.ready = true; }\n" +
      "});\n");
    write("web/fileNoteItem.html", '<button ng-click="refreshSection()">Refresh</button>\n');
    write("src/FileNoteService.java",
      '@Path("fileNote")\npublic class FileNoteService {\n  @PUT\n  @Path("refreshSection/{id}")\n  public Response refreshSection(String id) { return ok(); }\n}\n');
    primeMatchers(REPO);
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  test("anchored on the isolated init leaf, the grow widens to the controller and reaches html + backend", async () => {
    if (!available()) return;
    _resetMatcherCacheMem();
    const [data] = await grow_to_terminals(REPO, "web/fileNoteItem.js", "initFileNoteItem", { bidirectional: true, dataCoupling: true });
    const files = [...new Set((data.nodes ?? []).map((n: any) => n.file).filter(Boolean))] as string[];
    expect(files.some((f) => f.endsWith("fileNoteItem.html"))).toBe(true);
    expect(files.some((f) => f.endsWith("FileNoteService.java"))).toBe(true);
  });
});
