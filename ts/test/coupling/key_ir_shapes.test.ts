// The `assign` + `attr` matcher SHAPES (key_ir.ts) — the IR vocabulary that lets the flywheel LEARN a
// template-mediated framework (AngularJS $scope ⇄ view) instead of hand-writing an adapter. The contract
// is GOLDEN EQUIVALENCE: two learned matchers (`assign` for the controller, `attr` for the template) must
// reproduce the EXACT keys the built-in ng_scope adapter emits — which is what will let us delete ng_scope.
// Both shapes parse with tree-sitter (js for assign, html/vue for attr), so they gate on `available()`.
import { describe, expect, test } from "bun:test";
import { validateMatcher, runMatcher } from "../../src/codebase/coupling/key_ir.js";
import { scan_file_keys } from "../../src/codebase/coupling/adapters/index.js";
import { available } from "../../src/codebase/atoms.js";

const CTRL = `angular.module('app').controller('FileNoteCtrl', function ($scope, $http) {
  $scope.refreshSection = function () { return $http.put('/rest/refreshSection/' + $scope.id); };
  $scope.generateFileNote = () => $http.put('/rest/generate/' + $scope.id);
  var local = function () {};   // NOT a $scope member → not a key
});`;
const VIEW = `<div ng-controller="FileNoteCtrl">
  <button ng-click="refreshSection()">Refresh</button>
  <button ng-click="generateFileNote()">Generate</button>
  <span>{{ generateFileNote() }}</span>
</div>`;

const vals = (hits: { value: string }[]) => hits.map((h) => h.value).sort();

describe("assign shape — `$scope.METHOD = function` (controller producer)", () => {
  const m = validateMatcher({ via: "assign", token: "$scope", kind: "binding", role: "produces" })!;
  test("matches ng_scope's PRODUCER keys exactly (and ignores a non-$scope local)", async () => {
    if (!available()) return;
    const got = await runMatcher(m, "ctrl.js", CTRL);
    const ngProd = scan_file_keys("ctrl.js", CTRL).filter((h) => h.kind === "ng-scope" && h.produces);
    expect(vals(got)).toEqual(vals(ngProd));                       // same values as the hand-written adapter
    expect(vals(got)).toEqual(["generateFileNote", "refreshSection"]);
    expect(got.every((h) => h.produces)).toBe(true);
  });
  test("a wrong receiver token matches nothing", async () => {
    if (!available()) return;
    expect(await runMatcher(validateMatcher({ via: "assign", token: "vm", kind: "binding", role: "produces" })!, "ctrl.js", CTRL)).toEqual([]);
  });
});

describe("attr shape — directive call ⇄ interpolation (template consumer)", () => {
  const m = validateMatcher({ via: "attr", directive: "ng-", keyFrom: "call", kind: "binding", role: "consumes" })!;
  test("matches ng_scope's CONSUMER keys exactly (ng-click calls + {{ }} interpolation)", async () => {
    if (!available()) return;
    const got = await runMatcher(m, "view.html", VIEW);
    const ngCons = scan_file_keys("view.html", VIEW).filter((h) => h.kind === "ng-scope" && !h.produces);
    expect(vals(got)).toEqual(vals(ngCons));                       // same multiset as the hand-written adapter
    expect(vals(got)).toEqual(["generateFileNote", "generateFileNote", "refreshSection"]);   // {{generateFileNote()}} counted too
    expect(got.every((h) => !h.produces)).toBe(true);
  });
});

describe("method shape — class method definition (Angular2+/React component producer)", () => {
  const m = validateMatcher({ via: "method", kind: "binding", role: "produces" })!;
  const COMPONENT = `@Component({ selector: 'fn', templateUrl: './fn.html' })
export class FileNoteComponent {
  constructor(private http: HttpClient) {}
  refreshSection() { return this.http.put('/r', {}); }
  generateFileNote = () => this.http.put('/g', {});   // field-arrow method also counts
  ngOnInit() {}                                       // a lifecycle method — emitted, but grounds only if a template names it
}`;
  test("every class method name is produced; constructor excluded", async () => {
    if (!available()) return;
    const got = await runMatcher(m, "fn.component.ts", COMPONENT);
    expect(vals(got)).toEqual(["generateFileNote", "ngOnInit", "refreshSection"]);   // no `constructor`
    expect(got.every((h) => h.produces)).toBe(true);
  });
});

describe("Angular2+ template grounding — (event) binding directive", () => {
  test("attr directive='(' keyFrom='call' reads the called method from `(click)=\"x()\"`", async () => {
    if (!available()) return;
    const cons = validateMatcher({ via: "attr", directive: "(", keyFrom: "call", kind: "binding", role: "consumes" })!;
    const tpl = `<button (click)="refreshSection()">x</button><span>{{ generateFileNote() }}</span>`;
    expect(vals(await runMatcher(cons, "fn.component.html", tpl))).toEqual(["generateFileNote", "refreshSection"]);
  });
  test("keyFrom='name' strips the sigils: `(click)` → click", async () => {
    if (!available()) return;
    const ev = validateMatcher({ via: "attr", directive: "(", keyFrom: "name", kind: "event", role: "consumes" })!;
    expect(vals(await runMatcher(ev, "c.html", `<b (click)="h()" (save)="s()">x</b>`))).toEqual(["click", "save"]);
  });
});

describe("attr shape — directive NAME (event listener)", () => {
  test("keyFrom='name' extracts the directive suffix (@event / v-on:event)", async () => {
    if (!available()) return;
    const tpl = `<child @sync="onSync" v-on:open="h"/>`;
    const at = validateMatcher({ via: "attr", directive: "@", keyFrom: "name", kind: "event", role: "consumes" })!;
    const von = validateMatcher({ via: "attr", directive: "v-on:", keyFrom: "name", kind: "event", role: "consumes" })!;
    expect(vals(await runMatcher(at, "c.vue", tpl))).toEqual(["sync"]);
    expect(vals(await runMatcher(von, "c.vue", tpl))).toEqual(["open"]);
  });
});
