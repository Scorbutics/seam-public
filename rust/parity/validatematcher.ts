// validateMatcher parity (Phase 5) — TS key_ir.validateMatcher vs Rust addon.validate_matchers over a fixed set
// of LLM-shaped objects covering all 9 vias + edge cases. Deterministic (no LLM); must be byte-identical (the
// gate that turns a model answer into an executable rule). Compares the produced matcher objects (deep-equal).

import { createRequire } from "node:module";
import { validateMatcher } from "../../ts/src/codebase/coupling/key_ir.js";

const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

// Test objects — the prompt's r1..r13 examples + edge cases (dotted callee, @-annotation, strip, kind aliases,
// invalid tokens, missing fields, name/description provided-vs-generated, dedup/filter verbs).
const objs: any[] = [
  { id: "r1", via: "call", token: "$emit", argIndex: 0, kind: "event", role: "produces", name: "vue-emit", description: "emits a component event" },
  { id: "r2", via: "attr", directive: "@", keyFrom: "name", kind: "event", role: "consumes", name: "vue-listener", description: "@event template listener" },
  { id: "r3", via: "assign", token: "$scope", kind: "binding", role: "produces", name: "scope-method", description: "defines an AngularJS $scope view method" },
  { id: "r4", via: "attr", directive: "ng-", keyFrom: "call", kind: "binding", role: "consumes", name: "ng-directive-call", description: "calls a scope method from an ng-* directive" },
  { id: "r5", via: "method", kind: "binding", role: "produces", name: "ng2-method", description: "Angular2+/React component class method" },
  { id: "r7", via: "call", token: "setItem", argIndex: 0, kind: "cache", role: "produces", name: "localstorage-write", description: "writes a localStorage key" },
  { id: "r9", via: "call", token: "convertAndSend", argIndex: 0, kind: "queue", role: "produces", name: "jms-send", description: "publishes to a JMS queue/topic" },
  { id: "r10", via: "annotation", annotation: "JmsListener", element: "destination", kind: "queue", role: "consumes", name: "jms-listener", description: "a method listening on a JMS queue/topic" },
  { id: "r13", via: "call", token: "exchange", argIndex: 0, kind: "egress", role: "produces", name: "resttemplate-egress", description: "outbound HTTP call" },
  // edge cases:
  { via: "call", token: "bus.publish", argIndex: 1, kind: "event", role: "produce" },          // dotted callee → last seg; role prefix "produce"
  { via: "call", token: "this.$emit", argIndex: 0, kind: "route", role: "produces" },            // kind alias route→http-route; generated name/desc
  { via: "call", token: "setAttribute", argIndex: 0, strip: "v-on:", kind: "event", role: "consumes" },  // strip
  { via: "call", token: "a.b.c", kind: "key" },                                                  // dotted → "c"; default role=consumes, argIndex=0
  { via: "call", token: "not-an-ident!", kind: "key", role: "produces" },                        // invalid token → null
  { via: "annotation", annotation: "@KafkaListener", kind: "queue", role: "consumes" },          // @-prefix stripped; no element
  { via: "member", token: "prisma", verbs: ["findMany", "create", "findMany"], kind: "db-table", role: "consumes" }, // verb dedup
  { via: "repository", token: "users", verbs: ["create", "!bad"], kind: "db-table", role: "produces" },  // filter bad verb
  { via: "channel", token: "MyFramework.http", verbs: ["get", "post"], kind: "http-route", role: "produces" }, // dotted receiver OK
  { via: "handle", token: "client.auth", verbs: ["login"], kind: "key", role: "consumes" },
  { via: "member", token: "prisma", verbs: [], kind: "db-table", role: "consumes" },             // no verbs → null
  { via: "channel", token: "bad!recv", verbs: ["x"], kind: "key", role: "produces" },            // bad receiver → null
  { via: "attr", directive: "(click)", keyFrom: "call", kind: "binding", role: "consumes" },     // Angular2 binding sigil
  { via: "attr", directive: "way-too-long-directive-name-exceeding", keyFrom: "name", kind: "key", role: "consumes" }, // >24 → null
  { via: "unknown-shape", token: "x", kind: "key", role: "produces" },                           // unknown via → null
  { via: "call", kind: "key", role: "produces" },                                                // missing token → null
  { via: "method", kind: "route", role: "consumes", name: "  Weird Name!! ", description: "  " }, // name slugged; empty desc → fallback
];

const rustOut: any[] = JSON.parse(addon.validateMatchers(JSON.stringify(objs)));
const tsOut = objs.map((o) => validateMatcher(o) ?? null);

const norm = (m: any) => (m == null ? "null" : JSON.stringify(Object.keys(m).sort().reduce((a: any, k) => ((a[k] = m[k]), a), {})));
let bad = 0;
for (let i = 0; i < objs.length; i++) {
  const t = norm(tsOut[i]), r = norm(rustOut[i]);
  if (t !== r) {
    bad++;
    console.log(`  [${i}] via=${objs[i].via} token=${objs[i].token ?? ""}`);
    console.log(`      TS  : ${t}`);
    console.log(`      Rust: ${r}`);
  }
}
console.log(`validateMatcher parity: ${objs.length - bad} ok / ${bad} bad (of ${objs.length})`);
process.exit(bad ? 1 : 0);
