// RUBY carrier adapter — the thin language layer the generic carrier machinery (coupling/carrier/lang)
// drives. Supplies the Ruby specifics: how to decompose a `call`, teacher-2 key recovery (literal +
// interpolated glob), the stdlib SINK REGISTRY (Marshal/File/IO), and resolve delegation to ruby_dispatch
// (whose mixin-MRO + const-nesting model is richer than Java/TS, so it stays bespoke). The scanFile loop,
// the trace walk, and the effect cache are generic.
import { field } from "../../core/treesitter.js";
import { buildRubyIndex, constName, inferAssignments, isDynamicDispatch, resolveMethodCall, resolveSelfCall, type RubyAssign, type RubyIndex } from "./dispatch.js";
import { makeCarrierProvider, type CarrierLang, type Receiver, type SinkResult } from "../../codebase/coupling/carrier/lang.js";
import type { Sink } from "../../codebase/coupling/carrier/trace.js";

// KNOWN terminal I/O sinks — CONSTANT-receiver class methods, `Receiver.method`. Closed stdlib set.
const _SINKS: Record<string, Sink> = {
  "Marshal.dump": { direction: "write", medium: "serialized" }, "Marshal.load": { direction: "read", medium: "serialized" },
  "File.binwrite": { direction: "write", medium: "file" }, "File.write": { direction: "write", medium: "file" },
  "File.binread": { direction: "read", medium: "file" }, "File.read": { direction: "read", medium: "file" },
  "IO.binwrite": { direction: "write", medium: "file" }, "IO.write": { direction: "write", medium: "file" },
  "IO.binread": { direction: "read", medium: "file" }, "IO.read": { direction: "read", medium: "file" },
};
// INSTANCE-method sinks on a provably-typed stdlib IO object (`@file = File.open` ⇒ `@file.write`). Keyed
// by method name — applied only when the receiver's inferred type is a stdlib IO type.
const _IO_SINKS: Record<string, Sink> = {
  write: { direction: "write", medium: "file" }, binwrite: { direction: "write", medium: "file" },
  print: { direction: "write", medium: "file" }, puts: { direction: "write", medium: "file" }, "<<": { direction: "write", medium: "file" },
  read: { direction: "read", medium: "file" }, binread: { direction: "read", medium: "file" },
  gets: { direction: "read", medium: "file" }, readline: { direction: "read", medium: "file" }, readlines: { direction: "read", medium: "file" },
};
const _IO_TYPES = new Set(["File", "IO", "StringIO", "Tempfile"]);
// CODE-EXECUTION terminals — a carrier reaching one loads/runs CODE, not data. `eval`/`*_eval`/`*_exec`
// for any receiver; the Kernel loaders only when RECEIVER-LESS (`Marshal.load` with a receiver is DATA).
const _CODE_EXEC_ANY = new Set(["eval", "instance_eval", "module_eval", "class_eval", "instance_exec", "module_exec", "class_exec"]);
const _CODE_LOAD_BARE = new Set(["require", "require_relative", "load", "autoload"]);

interface RubyEnv { assigns: RubyAssign[]; typeOf: Map<string, string> }

const _receiver = (recv: any): Receiver => {
  if (!recv) return { kind: "none" };
  const c = constName(recv);
  if (c) return { kind: "type", text: c };
  if (recv.type === "identifier" || recv.type === "instance_variable") return { kind: "name", text: recv.text };
  return { kind: "other", text: recv.text };
};

// TEACHER 2 — a string-literal key, OR a PARTIAL family pattern from an interpolated string
// (`"Data/#{lang}.dat"` → `Data/*.dat`). A string with no literal content is fully dynamic → no key.
function _keyPattern(n: any): { value: string; partial: boolean } | null {
  if (!n || n.type !== "string") return null;
  let val = "", partial = false, hasLiteral = false;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c.type === "interpolation") { val += "*"; partial = true; }
    else if (c.type === "escape_sequence") return null;
    else if (c.type.includes("content")) { val += c.text; hasLiteral = true; }
  }
  return hasLiteral ? { value: val.replace(/\*+/g, "*"), partial } : null;
}

const RUBY: CarrierLang<RubyIndex, RubyEnv> = {
  name: "Ruby",
  extensions: [".rb", ".rake"],
  callKind: "call",
  selfFallback: "Object",                       // Ruby top-level methods are private instance methods of Object
  grammar: () => "ruby",
  buildIndex: buildRubyIndex,
  decompose(call) {
    const mname = field(call, "method")?.text;
    if (!mname) return null;
    const args = field(call, "arguments");
    const argList: any[] = [];
    if (args) for (let i = 0; i < args.namedChildCount; i++) argList.push(args.namedChild(i));
    return { method: mname, receiver: _receiver(field(call, "receiver")), args: argList, row: call.startPosition.row };
  },
  keyPattern: _keyPattern,
  typeEnv(root) {
    const assigns = inferAssignments("", root);
    const typeOf = new Map<string, string>();
    for (const a of assigns) typeOf.set(a.name, a.fqn);   // last assignment wins (for the IO-type sink check)
    return { assigns, typeOf };
  },
  sinkFor(call, env): SinkResult {
    const r = call.receiver;
    if (r.kind === "type") { const s = _SINKS[`${r.text}.${call.method}`]; return s ? { sink: s } : null; }
    if (r.kind === "name") { const t = env.typeOf.get(r.text); if (t && _IO_TYPES.has(t)) { const s = _IO_SINKS[call.method]; return s ? { sink: s } : { benign: true }; } }
    return null;
  },
  isCodeLoad: (call) => _CODE_EXEC_ANY.has(call.method) || (call.receiver.kind === "none" && _CODE_LOAD_BARE.has(call.method)),
  isDynamic: (call) => isDynamicDispatch(call.method),
  resolve(index, call, enclosing, env) {
    const r = call.receiver;
    if (r.kind === "none") return enclosing ? resolveSelfCall(index, enclosing, call.method) : [];
    const nesting = enclosing ? (index.get(enclosing)?.nesting ?? []) : [];
    if (r.kind === "type" || r.kind === "name" || r.kind === "other") return resolveMethodCall(index, r.text, call.method, env.assigns, call.row, nesting);
    return [];
  },
  findMethodNode(root, method, line) {
    let found: any = null;
    const visit = (n: any) => {
      if (found) return;
      if ((n.type === "method" || n.type === "singleton_method") && field(n, "name")?.text === method && n.startPosition.row === line) { found = n; return; }
      for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
    };
    visit(root);
    return found;
  },
};

export const RUBY_LANG = RUBY;
export const RUBY_CARRIER = makeCarrierProvider(RUBY);
