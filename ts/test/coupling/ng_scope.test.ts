// AngularJS $scope-method ⇄ template binding (the template-mediated flow Seam used to miss): a controller
// defines `$scope.refreshSection = function(){ $http.put(...) }`, the .html INVOKES it via
// `ng-click="refreshSection()"` — no JS call edge, the wire is the shared method NAME. This lets a footprint
// anchored on one scope method reach its SIBLING methods (and their backend calls) through the template that
// binds them all. Deterministic + statically resolvable.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scan_file_keys, scannableForKeys } from "../../src/codebase/coupling/index.js";
import { build_module_graph } from "../../src/codebase/scan/module_graph.js";
import { build_consumers_graph } from "../../src/codebase/scan/consumers_graph.js";
import { available } from "../../src/codebase/atoms.js";

const ng = (file: string, text: string) => scan_file_keys(file, text).filter((h) => h.kind === "ng-scope");

describe("ng-scope adapter — producer side ($scope.method definitions in the controller)", () => {
  test("$scope.x = function / async function / arrow → produced binding", () => {
    const p = ng("ctrl.js", "$scope.refreshSection = function(){};\n$scope.load = async function(){};\n$scope.total = () => 1;\n$scope.fmt = d => d;");
    expect(p.filter((h) => h.produces).map((h) => h.value).sort()).toEqual(["fmt", "load", "refreshSection", "total"]);
  });
  test("a non-function $scope assignment is NOT a binding", () => {
    expect(ng("ctrl.js", '$scope.title = "Hello";\n$scope.count = 0;')).toEqual([]);
  });
});

describe("ng-scope adapter — consumer side (template references)", () => {
  const consumed = (text: string) => ng("v.html", text).filter((h) => !h.produces).map((h) => h.value);
  test("ng-click / ng-change / ng-init calls → consumed bindings", () => {
    expect(consumed('<button ng-click="refreshSection()">x</button>')).toContain("refreshSection");
    expect(consumed('<div ng-init="initFileNoteItem()"></div>')).toContain("initFileNoteItem");
    expect(consumed('<input ng-change="onChange(item.id)">')).toContain("onChange");
  });
  test("{{ interpolation }} method call → consumed", () => {
    expect(consumed("<span>{{ computeTotal() }}</span>")).toContain("computeTotal");
  });
  test("controllerAs vm.method() → the method name is captured", () => {
    expect(consumed('<button ng-click="vm.save()">x</button>')).toContain("save");
  });
  test("non-ng attributes and value-only bindings are NOT consumers", () => {
    expect(ng("v.html", '<div class="refreshSection" ng-model="user.name"></div>')).toEqual([]);
  });
  test(".html templates are walked for keys", () => {
    expect(scannableForKeys("fileNoteItem.html")).toBe(true);
  });
});

// The end-to-end win: a footprint anchored on the controller's INIT method reaches a SIBLING scope method
// (and its JAX-RS backend) through the template that binds both — the flow is template-mediated but static.
describe("cross-boundary: init method → template → sibling $http method → backend", () => {
  const REPO = join(tmpdir(), "seam-ngscope-" + process.pid);
  const write = (rel: string, text: string) => { mkdirSync(join(REPO, rel, ".."), { recursive: true }); writeFileSync(join(REPO, rel), text); };
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
  });
  afterAll(() => rmSync(REPO, { recursive: true, force: true }));

  const reaches = (g: any, suffix: string) => (g.nodes ?? []).some((n: any) => String(n.file).endsWith(suffix));
  test("anchored on initFileNoteItem, the footprint reaches the template AND the JAX-RS backend", async () => {
    if (!available()) return;   // tree-sitter required
    const g = await build_consumers_graph(REPO, "web/fileNoteItem.js", "initFileNoteItem", { dataCoupling: true });
    expect(reaches(g, "fileNoteItem.html")).toBe(true);          // init → template (ng-scope binding)
    expect(reaches(g, "FileNoteService.java")).toBe(true);       // → sibling refreshSection → $http route → backend
  });
  test("module mode reaches the template + backend too", async () => {
    if (!available()) return;
    const g = await build_module_graph(REPO, "web/fileNoteItem.js", { dataCoupling: true });
    expect(reaches(g, "fileNoteItem.html")).toBe(true);
    expect(reaches(g, "FileNoteService.java")).toBe(true);
  });
});
