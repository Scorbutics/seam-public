// THE language-agnostic carrier machinery. A language plugs in a thin `CarrierLang` adapter (grammar
// node-kinds + a sink registry + how to read a call) and gets, for free: the provider scanFile loop
// (teacher 2 + orchestration), the trace WALK's classify ladder (teacher 1), the per-index effect cache,
// and the method-source lookup. Everything that was copy-pasted per language now lives here ONCE; the
// per-language files shrank to just what the grammar forces to differ.
import { collectByType, getParser, parseFile } from "../../../core/treesitter.js";
import { enclosingClass, methodDef, pinned, repoMethodNames, type MethodCandidate, type MethodIndex } from "../../../core/dispatch.js";
import { traceToSinks, type CallGraph, type CarrierEffect, type Sink, type TraceCall } from "./trace.js";
import type { CarrierObservation, CarrierProvider } from "./provider.js";

// A call's receiver, normalised so the shared classifier/resolver never touches an AST.
export type Receiver =
  | { kind: "none" }                  // a bare, receiver-less call (self in Ruby/Java; module scope in TS)
  | { kind: "self" }                  // explicit this/self → the enclosing class
  | { kind: "type"; text: string }    // a Type/constant receiver (Files, Marshal, Store)
  | { kind: "name"; text: string }    // a variable / ivar / identifier receiver
  | { kind: "other"; text: string };  // a chain / computed / otherwise-unknown receiver

// A decomposed call: the normalised currency the generic machinery reads instead of grammar nodes.
export interface Call { method: string; receiver: Receiver; args: any[]; row: number }

// Sink classification: a real I/O sink, a benign op on a known-IO receiver (neither sink nor blindspot —
// stops the fall-through to resolution), or null = not I/O (resolve & follow it).
export type SinkResult = { sink: Sink } | { benign: true } | null;

// The THIN per-language adapter. `Idx` = the language's index (must expose the common method shape);
// `Env` = whatever per-method type evidence the language wants to thread (opaque to the generic).
export interface CarrierLang<Idx extends MethodIndex, Env> {
  name: string;
  extensions: string[];
  callKind: string;                                       // tree-sitter call node kind to collect
  selfFallback: string | null;                            // enclosing scope for a self/bare call with no class
  grammar(file: string): string;
  buildIndex(repo: string): Promise<Idx>;
  decompose(callNode: any): Call | null;                  // a call node → a normalised Call
  keyPattern(argNode: any): { value: string; partial: boolean } | null;   // teacher 2
  typeEnv(root: any): Env;                                // per-file type evidence (for sinks + var resolution)
  sinkFor(call: Call, env: Env): SinkResult;
  isCodeLoad(call: Call): boolean;
  isDynamic(call: Call): boolean;
  resolve(index: Idx, call: Call, enclosing: string | null, env: Env): MethodCandidate[];   // → index-backed candidates
  findMethodNode(root: any, method: string, line: number): any | null;
}

// Classify one decomposed call into a generic TraceCall (the shared teacher-1 ladder).
function classify<Idx extends MethodIndex, Env>(lang: CarrierLang<Idx, Env>, index: Idx, call: Call, enclosing: string | null, env: Env, repoMethods: Set<string>): TraceCall {
  if (lang.isCodeLoad(call)) return { kind: "codeLoad" };
  const sr = lang.sinkFor(call, env);
  if (sr) return "sink" in sr ? { kind: "sink", direction: sr.sink.direction, medium: sr.sink.medium } : { kind: "ignore" };
  if (lang.isDynamic(call)) return { kind: "dynamic", label: `dynamic:${call.method}` };
  const hits = pinned(lang.resolve(index, call, enclosing, env));
  if (hits.length) return { kind: "follow", targets: hits };
  const r = call.receiver;
  if (r.kind === "type" || r.kind === "name" || r.kind === "other")   // a real receiver we couldn't pin → opaque/blindspot
    return { kind: "unresolved", external: true, blindspot: repoMethods.has(call.method) ? `${r.text}.${call.method}` : undefined };
  return { kind: "ignore" };                                          // a self/bare call we couldn't resolve → not a carrier
}

// Build the language's CallGraph (a method body → its classified calls) for the generic walk.
function callGraph<Idx extends MethodIndex, Env>(lang: CarrierLang<Idx, Env>, repo: string, index: Idx): CallGraph {
  const repoMethods = repoMethodNames(index);
  return {
    async callsOf(className, method): Promise<TraceCall[] | null> {
      const def = methodDef(index, className, method);
      if (!def) return null;
      const root = await parseFile(repo, def.file, lang.grammar(def.file));
      if (!root) return null;
      const mnode = lang.findMethodNode(root, method, def.line);
      if (!mnode) return null;
      const env = lang.typeEnv(root);
      const out: TraceCall[] = [];
      for (const node of collectByType(mnode, lang.callKind)) {
        const call = lang.decompose(node);
        if (call) out.push(classify(lang, index, call, className, env, repoMethods));
      }
      return out;
    },
  };
}

// One CallGraph per (repo) index — keyed by the index object, built once, lazy.
const _graphOf = new WeakMap<object, CallGraph>();
export function traceCarrierWith<Idx extends MethodIndex & object, Env>(lang: CarrierLang<Idx, Env>, repo: string, index: Idx, className: string, method: string): Promise<CarrierEffect> {
  let g = _graphOf.get(index);
  if (!g) { g = callGraph(lang, repo, index); _graphOf.set(index, g); }
  return traceToSinks(g, className, method);
}

export async function methodSourceWith<Idx extends MethodIndex, Env>(lang: CarrierLang<Idx, Env>, repo: string, index: Idx, className: string, method: string): Promise<string | null> {
  const def = methodDef(index, className, method);
  if (!def) return null;
  const root = await parseFile(repo, def.file, lang.grammar(def.file));
  if (!root) return null;
  const node = lang.findMethodNode(root, method, def.line);
  return node ? node.text : null;
}

// The generic CarrierProvider — the scanFile loop (teacher 2 key recovery → resolve → trace effect →
// emit observation) wrapped around the adapter. Identical for every language.
export function makeCarrierProvider<Idx extends MethodIndex & object, Env>(lang: CarrierLang<Idx, Env>): CarrierProvider<Idx> {
  const dirCacheOf = new WeakMap<Idx, Map<string, CarrierEffect>>();
  return {
    name: lang.name,
    handles: (file) => lang.extensions.some((e) => file.endsWith(e)),
    buildIndex: (repo) => lang.buildIndex(repo),
    methodSource: (repo, index, c, m) => methodSourceWith(lang, repo, index, c, m),
    async scanFile(repo, index, file, text): Promise<CarrierObservation[]> {
      const parser = await getParser(lang.grammar(file));
      if (!parser) return [];
      let root: any;
      try { root = parser.parse(text).rootNode; } catch { return []; }
      const env = lang.typeEnv(root);
      let dc = dirCacheOf.get(index);
      if (!dc) { dc = new Map(); dirCacheOf.set(index, dc); }
      const effOf = async (cls: string, m: string): Promise<CarrierEffect> => {
        const k = `${cls}#${m}`;
        if (dc!.has(k)) return dc!.get(k)!;
        const e = await traceCarrierWith(lang, repo, index, cls, m);
        dc!.set(k, e);
        return e;
      };
      const out: CarrierObservation[] = [];
      for (const node of collectByType(root, lang.callKind)) {
        const call = lang.decompose(node);
        if (!call) continue;
        let key: { value: string; partial: boolean } | null = null;
        for (const a of call.args) { const k = lang.keyPattern(a); if (k) { key = k; break; } }
        if (!key) continue;
        const enclosing = enclosingClass(index, file, call.row, lang.selfFallback);
        for (const c of pinned(lang.resolve(index, call, enclosing, env))) {
          const eff = await effOf(c.className, c.method);
          if (eff.codeLoad) continue;
          const dir = eff.directions.includes("write") ? "write" : eff.directions.includes("read") ? "read" : null;
          if (dir) { out.push({ value: key.value, partial: key.partial, line: call.row, callee: { className: c.className, method: c.method }, direction: dir }); continue; }
          if (eff.external && eff.directions.length === 0)
            out.push({ value: key.value, partial: key.partial, line: call.row, callee: { className: c.className, method: c.method }, direction: null });
        }
      }
      return out;
    },
  };
}
