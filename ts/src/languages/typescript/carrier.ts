// TYPESCRIPT/JS carrier adapter — the thin language layer the generic carrier machinery drives. Supplies
// only the TS specifics: how to decompose a `call_expression`, teacher-2 key recovery (string + template
// literal glob), the node `fs` SINK REGISTRY, and resolve delegation to ts_dispatch. The scanFile loop,
// trace walk, and effect cache are generic.
import { field } from "../../core/treesitter.js";
import { buildTsIndex, inferAssignments, resolveMethodCall, resolveSelfCall, grammarFor, EXTENSIONS, MODULE, type TsIndex } from "./dispatch.js";
import { makeCarrierProvider, type CarrierLang, type Receiver, type SinkResult } from "../../codebase/coupling/carrier/lang.js";
import type { Sink } from "../../codebase/coupling/carrier/trace.js";

// `receiver.method` sinks, keyed by the receiver TEXT so a member chain (`fs.promises.writeFile`) matches.
const _SINKS: Record<string, Sink> = {
  "fs.writeFileSync": { direction: "write", medium: "file" }, "fs.writeFile": { direction: "write", medium: "file" },
  "fs.appendFileSync": { direction: "write", medium: "file" }, "fs.appendFile": { direction: "write", medium: "file" },
  "fs.promises.writeFile": { direction: "write", medium: "file" }, "fs.promises.appendFile": { direction: "write", medium: "file" },
  "fs.readFileSync": { direction: "read", medium: "file" }, "fs.readFile": { direction: "read", medium: "file" },
  "fs.promises.readFile": { direction: "read", medium: "file" },
};
// Direct-imported sinks (`import { writeFileSync } from "node:fs"`) — a bare, receiver-less call.
const _BARE_SINKS: Record<string, Sink> = {
  writeFileSync: { direction: "write", medium: "file" }, appendFileSync: { direction: "write", medium: "file" },
  readFileSync: { direction: "read", medium: "file" },
};
const _CODE_EXEC = new Set(["eval", "Function"]);

// Decompose a call_expression's callee into a normalised receiver + method name.
function _callee(fn: any): { receiver: Receiver; method: string } | null {
  if (fn.type === "subscript_expression") return { receiver: { kind: "other", text: fn.text }, method: "" };   // obj[expr]() → dynamic
  if (fn.type === "member_expression") {
    const obj = field(fn, "object"), prop = field(fn, "property")?.text;
    if (!prop) return null;
    if (obj?.type === "this") return { receiver: { kind: "self" }, method: prop };
    return { receiver: obj ? { kind: "name", text: obj.text } : { kind: "none" }, method: prop };
  }
  if (fn.type === "identifier") return { receiver: { kind: "none" }, method: fn.text };
  return null;
}

const TS: CarrierLang<TsIndex, Map<string, string>> = {
  name: "TypeScript",
  extensions: EXTENSIONS,
  callKind: "call_expression",
  selfFallback: MODULE,
  grammar: grammarFor,
  buildIndex: buildTsIndex,
  decompose(call) {
    const fn = field(call, "function");
    if (!fn) return null;
    const c = _callee(fn);
    if (!c || (c.method === "" && c.receiver.kind !== "other")) return null;
    const args = field(call, "arguments");
    const argList: any[] = [];
    if (args) for (let i = 0; i < args.namedChildCount; i++) argList.push(args.namedChild(i));
    return { method: c.method, receiver: c.receiver, args: argList, row: call.startPosition.row };
  },
  keyPattern(n) {
    if (!n || (n.type !== "string" && n.type !== "template_string")) return null;
    let val = "", partial = false, hasLiteral = false;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c.type === "template_substitution") { val += "*"; partial = true; }
      else if (c.type === "escape_sequence") return null;
      else if (c.type === "string_fragment") { val += c.text; hasLiteral = true; }
    }
    return hasLiteral ? { value: val.replace(/\*+/g, "*"), partial } : null;
  },
  typeEnv: (root) => inferAssignments(root),
  sinkFor(call): SinkResult {
    const r = call.receiver;
    if (r.kind === "name") { const s = _SINKS[`${r.text}.${call.method}`]; if (s) return { sink: s }; }
    if (r.kind === "none") { const s = _BARE_SINKS[call.method]; if (s) return { sink: s }; }
    return null;
  },
  isCodeLoad: (call) => _CODE_EXEC.has(call.method) || (call.receiver.kind === "none" && call.method === "require"),
  isDynamic: (call) => call.method === "" /* computed member */ || call.method === "call" || call.method === "apply",
  resolve(index, call, enclosing, typeOf) {
    const r = call.receiver;
    if (r.kind === "self") return enclosing ? resolveSelfCall(index, enclosing, call.method) : [];
    if (r.kind === "none") return resolveSelfCall(index, MODULE, call.method);   // a bare call → module scope
    if (r.kind === "name" || r.kind === "type" || r.kind === "other") return resolveMethodCall(index, r.text, call.method, typeOf);
    return [];
  },
  findMethodNode(root, method, line) {
    let found: any = null;
    const visit = (n: any) => {
      if (found) return;
      if ((n.type === "method_definition" || n.type === "function_declaration") && n.startPosition.row === line && field(n, "name")?.text === method) { found = n; return; }
      for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
    };
    visit(root);
    return found;
  },
};

export const TS_LANG = TS;
export const TS_CARRIER = makeCarrierProvider(TS);
