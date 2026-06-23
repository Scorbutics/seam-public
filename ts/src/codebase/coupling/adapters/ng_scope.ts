// FRAMEWORK adapter: AngularJS $scope-method ⇄ TEMPLATE binding — the control-flow boundary an AngularJS
// component crosses through its view. A controller defines `$scope.refreshSection = function () { … }`; the
// `.html` template INVOKES it (`ng-click="refreshSection()"`, `{{ total() }}`). There is NO import/call edge
// — the wire is the shared METHOD NAME across the `.js` ⇄ `.html` boundary (the same shape as the event
// adapter). This is what lets a footprint anchored on one scope method reach its SIBLING methods (and their
// `$http` backend calls) through the template that binds them all — the AngularJS flow is template-mediated
// but fully static. Deterministic; the template side is liberal (any call) and self-corrects via grounding:
// only a name that ALSO has a `$scope.` definition couples; the rest are ungrounded floor keys, dropped.
import type { KeyHit, KeyKind, MaskCtx } from "../types.js";
import { lineOf, maskComments } from "./util.js";

export const NG_SCOPE_META = { kind: "ng-scope", nodeKind: "binding", produceEdge: "scope-define", consumeEdge: "scope-call" } as const;

const JS_EXT = /\.(?:[mc]?[jt]sx?)$/i;
const HTML_EXT = /\.html?$/i;
// PRODUCER (.js controller): `$scope.METHOD = function|async function|(…)=>|x=>`. The scope method the view calls.
const SCOPE_DEF = /\$scope\.([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[a-zA-Z_$][\w$]*\s*=>)/g;
// CONSUMER (.html template): a method CALLED inside an ng-/on- directive expression or an {{interpolation}}.
const NG_EXPR = /(?:\b(?:ng-[\w-]+|on-[\w-]+|data-ng-[\w-]+)\s*=\s*["']([^"']*)["'])|\{\{([^}]*)\}\}/g;
const CALL = /([a-zA-Z_$][\w$]*)\s*\(/g;   // identifier directly before `(` — for `vm.foo(` this captures `foo`

function scan(file: string, text: string, masked?: MaskCtx): KeyHit[] {
  const out: KeyHit[] = [];
  if (JS_EXT.test(file)) {
    const t = masked?.comments ?? maskComments(text);   // a `$scope.x = function` in a comment is not a real definition
    let m: RegExpExecArray | null; SCOPE_DEF.lastIndex = 0;
    while ((m = SCOPE_DEF.exec(t)) !== null) out.push({ kind: "ng-scope", value: m[1], line: lineOf(t, m.index), produces: true });
  } else if (HTML_EXT.test(file)) {
    let e: RegExpExecArray | null; NG_EXPR.lastIndex = 0;
    while ((e = NG_EXPR.exec(text)) !== null) {
      const expr = e[1] ?? e[2] ?? "";
      let c: RegExpExecArray | null; CALL.lastIndex = 0;
      while ((c = CALL.exec(expr)) !== null) out.push({ kind: "ng-scope", value: c[1], line: lineOf(text, e.index), produces: false });
    }
  }
  return out;
}

export const NG_SCOPE: KeyKind = {
  ...NG_SCOPE_META, name: "ng-scope",
  blurb: "AngularJS $scope.method ⇄ template ng-click/{{}} call — controller↔view binding",
  extraExts: [".html", ".htm"], scan,
};
