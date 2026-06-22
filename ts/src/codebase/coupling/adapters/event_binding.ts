// FRAMEWORK adapter: a UI EVENT — the data-flow boundary an event-driven component flow crosses with NO
// import/call edge. A child component `$emit('sync')`s; the parent LISTENS in its TEMPLATE (`@sync="…"` /
// `v-on:sync="…"`), and the handler that actually runs is a THIRD, differently-named method. There is no
// call edge from child to parent — the wire is the shared EVENT NAME. That is exactly the shared-key shape
// this rung grounds: the event name is the key, the emitter PRODUCES it, the listener CONSUMES it, and the
// co-occurrence of the same name on both sides couples the two files (the parent then continues by ordinary
// call edges from its handler method). Vue (this.$emit / setup emit / @event / v-on:event) and AngularJS
// scope events ($scope.$emit / $broadcast / $on) share this shape.
//
// The LITERAL forms are the deterministic floor here; the COMPUTED ones (`'onSubEntryOpen' + suffix`) stay
// the LLM tier's job — a key assembled at runtime can't appear as the same literal on both sides, so it
// can't co-occur, by design (a wrong/ungrounded guess is dropped). Note the EVENT NAME still grounds even
// in the dynamic `setAttribute('v-on:open', …)` case (the metawidget pattern); only the handler-NAME
// computation is the residual blindspot.
import type { KeyHit, KeyKind } from "../types.js";
import { lineOf, maskComments } from "./util.js";

export const EVENT_BINDING_META = { kind: "event", nodeKind: "event", produceEdge: "event-emit", consumeEdge: "event-on" } as const;

// JS/TS source + the TEMPLATE files event listeners live in (.vue SFC, AngularJS/HTML templates). The
// template extensions are NOT in the global SOURCE_EXTS (no parser/resolver for them), so the adapter
// declares them via `extraExts` (below) to make the coupling scan WALK them even though the rest of the
// pipeline doesn't treat them as source.
const EVENT_EXT = /\.(?:[mc]?[jt]sx?|vue|html?)$/i;

// PRODUCER — an emit of an event by literal name: Vue `this.$emit('sync')` / setup `emit('sync')` /
// `ctx.emit('x')`, AngularJS `$scope.$emit('x')` / `$broadcast('x')`, node `emitter.emit('x')`. The
// `(?<![\w$])` keeps `submit(`/`_emit(` out while allowing `.emit`, `$emit`, and a bare `emit(`.
const EMIT = /(?<![\w$])\$?(?:emit|broadcast)\s*\(\s*[`'"]([^`'"]+)/g;
// CONSUMER (template) — a listener binding `@event="…"` / `v-on:event="…"` (optional `.modifiers`), with a
// required `="` so a `@Component(` decorator or an `a@b` email is not mistaken for a listener.
const LISTEN_TPL = /(?<![\w])(?:@|v-on:)([a-zA-Z][\w-]*)(?:\.[\w-]+)*\s*=\s*["']/g;
// CONSUMER (AngularJS scope) — `$scope.$on('x')` / `$rootScope.$on('x')`.
const LISTEN_ON = /\$on\s*\(\s*[`'"]([^`'"]+)/g;
// CONSUMER (dynamic) — a listener wired by string: `el.setAttribute('v-on:open', …)` / `'@open'`. The
// metawidget case: the EVENT NAME grounds here even though the bound handler name is computed.
const LISTEN_SETATTR = /setAttribute\s*\(\s*[`'"](?:v-on:|@)([\w-]+)/g;

function scan(file: string, text: string): KeyHit[] {
  if (!EVENT_EXT.test(file)) return [];
  text = maskComments(text);   // a `$emit('x')` (or `@x="…"`) inside a comment is not a real binding
  const out: KeyHit[] = [];
  const push = (name: string, idx: number, produces: boolean) => {
    const value = name.trim();
    if (value) out.push({ kind: "event", value, line: lineOf(text, idx), produces });
  };
  for (const [re, produces] of [[EMIT, true], [LISTEN_TPL, false], [LISTEN_ON, false], [LISTEN_SETATTR, false]] as const) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) push(m[1], m.index, produces);
  }
  return out;
}

export const EVENT_BINDING: KeyKind = {
  ...EVENT_BINDING_META,
  name: "vue-event",
  blurb: "Vue/AngularJS event $emit ⇄ @event/v-on/$on listener — event-binding coupling",
  extraExts: [".vue", ".html", ".htm"],
  scan,
};
