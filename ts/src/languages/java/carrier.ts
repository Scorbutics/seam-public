// JAVA carrier adapter — the thin language layer the generic carrier machinery (coupling/carrier/lang)
// drives. It supplies only the Java specifics: the call node-kind, how to decompose a `method_invocation`,
// teacher-2 key recovery (string literal + `+`-concat glob), the stdlib SINK REGISTRY (java.nio Files,
// the I/O streams, ObjectOutput/InputStream), and the resolve delegation to java_dispatch. The scanFile
// loop, the trace walk, and the effect cache are all generic.
import { collectByType, field } from "../../core/treesitter.js";
import { buildJavaIndex, inferAssignments, resolveMethodCall, resolveSelfCall, typeName, type JavaIndex } from "./dispatch.js";
import { makeCarrierProvider, type CarrierLang, type Receiver, type SinkResult } from "../../codebase/coupling/carrier/lang.js";
import type { Sink } from "../../codebase/coupling/carrier/trace.js";

// Static `Type.method` sinks (java.nio).
const _SINKS: Record<string, Sink> = {
  "Files.write": { direction: "write", medium: "file" }, "Files.writeString": { direction: "write", medium: "file" },
  "Files.newBufferedWriter": { direction: "write", medium: "file" }, "Files.newOutputStream": { direction: "write", medium: "file" },
  "Files.readAllBytes": { direction: "read", medium: "file" }, "Files.readAllLines": { direction: "read", medium: "file" },
  "Files.readString": { direction: "read", medium: "file" }, "Files.lines": { direction: "read", medium: "file" },
  "Files.newBufferedReader": { direction: "read", medium: "file" }, "Files.newInputStream": { direction: "read", medium: "file" },
};
// Instance sinks keyed `Type.method`, applied ONLY on a provably-typed stdlib IO receiver.
const _IO_SINKS: Record<string, Sink> = {
  "FileWriter.write": { direction: "write", medium: "file" }, "BufferedWriter.write": { direction: "write", medium: "file" },
  "PrintWriter.write": { direction: "write", medium: "file" }, "PrintWriter.print": { direction: "write", medium: "file" }, "PrintWriter.println": { direction: "write", medium: "file" },
  "FileOutputStream.write": { direction: "write", medium: "file" }, "OutputStream.write": { direction: "write", medium: "file" },
  "ObjectOutputStream.writeObject": { direction: "write", medium: "serialized" },
  "FileReader.read": { direction: "read", medium: "file" }, "BufferedReader.read": { direction: "read", medium: "file" }, "BufferedReader.readLine": { direction: "read", medium: "file" },
  "FileInputStream.read": { direction: "read", medium: "file" }, "InputStream.read": { direction: "read", medium: "file" },
  "ObjectInputStream.readObject": { direction: "read", medium: "serialized" },
};
const _IO_TYPES = new Set(["FileWriter", "BufferedWriter", "PrintWriter", "FileOutputStream", "OutputStream", "ObjectOutputStream", "FileReader", "BufferedReader", "FileInputStream", "InputStream", "ObjectInputStream"]);
const _CODE_LOAD = new Set(["Class.forName", "ClassLoader.loadClass", "System.load", "System.loadLibrary"]);

const _receiver = (recv: any): Receiver => {
  if (!recv) return { kind: "none" };
  if (recv.type === "this") return { kind: "self" };
  if (/^[A-Z]/.test(recv.text) && (recv.type === "identifier" || recv.type === "scoped_identifier" || recv.type === "field_access")) return { kind: "type", text: typeName(recv) ?? recv.text };
  if (recv.type === "identifier" || recv.type === "field_access") return { kind: "name", text: recv.text };
  return { kind: "other", text: recv.text };
};

// TEACHER 2 — string_literal content, OR a `+`-concat family pattern (`"Data/"+lang+".dat"` → `Data/*.dat`).
function _concat(n: any): { value: string; partial: boolean; hasLiteral: boolean } {
  if (n.type === "string_literal") { let v = ""; for (const f of collectByType(n, "string_fragment")) v += f.text; return { value: v, partial: false, hasLiteral: true }; }
  if (n.type === "binary_expression" && field(n, "operator")?.text === "+") {
    const l = _concat(field(n, "left")), r = _concat(field(n, "right"));
    return { value: l.value + r.value, partial: l.partial || r.partial, hasLiteral: l.hasLiteral || r.hasLiteral };
  }
  return { value: "*", partial: true, hasLiteral: false };   // a non-literal operand → a hole
}

const JAVA: CarrierLang<JavaIndex, Map<string, string>> = {
  name: "Java",
  extensions: [".java"],
  callKind: "method_invocation",
  selfFallback: null,
  grammar: () => "java",
  buildIndex: buildJavaIndex,
  decompose(call) {
    const mname = field(call, "name")?.text;
    if (!mname) return null;
    const args = field(call, "arguments");
    const argList: any[] = [];
    if (args) for (let i = 0; i < args.namedChildCount; i++) argList.push(args.namedChild(i));
    return { method: mname, receiver: _receiver(field(call, "object")), args: argList, row: call.startPosition.row };
  },
  keyPattern(n) {
    if (!n || (n.type !== "string_literal" && n.type !== "binary_expression")) return null;
    const c = _concat(n);
    return c.hasLiteral ? { value: c.value.replace(/\*+/g, "*"), partial: c.partial } : null;
  },
  typeEnv: (root) => inferAssignments(root),
  sinkFor(call, typeOf): SinkResult {
    const r = call.receiver;
    if (r.kind === "type") { const s = _SINKS[`${r.text}.${call.method}`]; return s ? { sink: s } : null; }
    if (r.kind === "name") { const t = typeOf.get(r.text); if (t && _IO_TYPES.has(t)) { const s = _IO_SINKS[`${t}.${call.method}`]; return s ? { sink: s } : { benign: true }; } }
    return null;
  },
  isCodeLoad: (call) => call.receiver.kind === "type" && _CODE_LOAD.has(`${call.receiver.text}.${call.method}`),
  isDynamic: (call) => call.method === "invoke",
  resolve(index, call, enclosing, typeOf) {
    const r = call.receiver;
    if (r.kind === "none" || r.kind === "self") return enclosing ? resolveSelfCall(index, enclosing, call.method) : [];
    if (r.kind === "type" || r.kind === "name" || r.kind === "other") return resolveMethodCall(index, r.text, call.method, typeOf);
    return [];
  },
  findMethodNode(root, method, line) {
    let found: any = null;
    const visit = (n: any) => {
      if (found) return;
      if ((n.type === "method_declaration" || n.type === "constructor_declaration") && n.startPosition.row === line && (field(n, "name")?.text === method || n.type === "constructor_declaration")) { found = n; return; }
      for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i));
    };
    visit(root);
    return found;
  },
};

export const JAVA_LANG = JAVA;
export const JAVA_CARRIER = makeCarrierProvider(JAVA);
