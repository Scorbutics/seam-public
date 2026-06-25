// FRAMEWORK adapter: Vue / JS SERVICE INJECTION (dependency injection via the instance). A plugin registers
// a service under a `$`-prefixed key on the prototype / global properties —
//   Vue.prototype.$bookingService = {…}                  (Vue 2)
//   app.config.globalProperties.$bookingService = {…}     (Vue 3)
//   Vue.prototype["$bookingService"] = {…}
// — and components CONSUME it as `this.$bookingService.method()`. The shared `$key` IS the coupling: the
// provider DEFINEs it, the consumer CALLs it (a `binding` boundary; grounded by co-occurrence like any
// shared key). This is a CLOSED structural shape (the `$` prefix on a prototype/globalProperties site), so
// it is a DETERMINISTIC floor adapter — it works without the LLM key-discovery flywheel and lets the local
// coupling gate see that an anchor using `this.$x` DOES touch a boundary (else it skips coupling entirely).
import type { KeyHit, KeyKind } from "../types.js";
import { lineOf } from "./util.js";

const EXTS = /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|vue)$/i;
// provider: <…>.prototype.$KEY  |  globalProperties.$KEY  |  …prototype["$KEY"] / globalProperties['$KEY']
const PROVIDER = /(?:\.prototype|globalProperties)\s*(?:\.\s*|\[\s*['"`])\s*(\$[A-Za-z_]\w*)/g;
// consumer: this.$KEY — the Vue instance convention; the `$` prefix keeps it discriminating (not `this.foo`).
const CONSUMER = /\bthis\s*\.\s*(\$[A-Za-z_]\w*)/g;

function scan(file: string, text: string): KeyHit[] {
  if (!EXTS.test(file)) return [];
  const out: KeyHit[] = [];
  let m: RegExpExecArray | null;
  PROVIDER.lastIndex = 0;
  while ((m = PROVIDER.exec(text)) !== null) out.push({ kind: "binding", value: m[1], line: lineOf(text, m.index), produces: true });
  CONSUMER.lastIndex = 0;
  while ((m = CONSUMER.exec(text)) !== null) out.push({ kind: "binding", value: m[1], line: lineOf(text, m.index), produces: false });
  return out;
}

export const VUE_INJECT: KeyKind = {
  kind: "binding", nodeKind: "binding", produceEdge: "binding-define", consumeEdge: "binding-call",
  name: "vue-inject", blurb: "Vue/JS service injection — Vue.prototype.$x / globalProperties.$x ⇄ this.$x",
  extraExts: [".vue"], scan,
};
