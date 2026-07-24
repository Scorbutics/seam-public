// key_store WRITE byte-identity (Phase 5) — Rust write_store_string vs TS JSON.stringify(store,null,2).
// Feeds validated matchers + learnedSigs and compares the exact bytes of the schema-3 key-adapters.json.

import { createRequire } from "node:module";
import { validateMatcher } from "../../ts/src/codebase/coupling/key_ir.js";

const require = createRequire(import.meta.url);
const addon = require("../seam_core.node");

// Validate a spread of objects (all 9 vias) → real matchers, exactly as the flywheel would persist them.
const raw: any[] = [
  { via: "call", token: "$emit", argIndex: 0, kind: "event", role: "produces", name: "vue-emit", description: "emits a component event" },
  { via: "call", token: "setAttribute", argIndex: 0, strip: "v-on:", kind: "event", role: "consumes" },
  { via: "assign", token: "$scope", kind: "binding", role: "produces" },
  { via: "method", kind: "route", role: "produces" },
  { via: "attr", directive: "@", keyFrom: "name", kind: "event", role: "consumes" },
  { via: "annotation", annotation: "JmsListener", element: "destination", kind: "queue", role: "consumes" },
  { via: "annotation", annotation: "@KafkaListener", kind: "queue", role: "consumes" },
  { via: "member", token: "prisma", verbs: ["findMany", "create"], kind: "db-table", role: "consumes" },
  { via: "repository", token: "users", verbs: ["create"], kind: "db-table", role: "produces" },
  { via: "channel", token: "bus", verbs: ["publish"], kind: "event", role: "produces" },
  { via: "handle", token: "client.auth", verbs: ["login"], kind: "key", role: "consumes" },
];
const matchers = raw.map((o) => validateMatcher(o)).filter(Boolean);
const sigs = ["abc123", "def456"];

const tsBytes = JSON.stringify({ schema: 3, rules: matchers, files: {}, learnedSigs: sigs }, null, 2);
const rustBytes = addon.writeStoreJson(JSON.stringify(matchers), JSON.stringify(sigs));

if (tsBytes === rustBytes) {
  console.log(`store-write parity: byte-identical OK (${matchers.length} rules, ${tsBytes.length} bytes)`);
  process.exit(0);
}
// show first divergence
let i = 0;
while (i < Math.min(tsBytes.length, rustBytes.length) && tsBytes[i] === rustBytes[i]) i++;
console.log(`store-write parity: DIFF at byte ${i} (TS ${tsBytes.length}B / Rust ${rustBytes.length}B)`);
console.log("  TS  …", JSON.stringify(tsBytes.slice(Math.max(0, i - 30), i + 40)));
console.log("  Rust…", JSON.stringify(rustBytes.slice(Math.max(0, i - 30), i + 40)));
process.exit(1);
