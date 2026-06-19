// RUBY carrier provider — the language implementation of CarrierProvider. Does the AST-bound work the
// engine can't: teacher 2 (recover the channel key from a call's string arg, literal or interpolated
// glob) and teacher 1 (resolve the callee via ruby_dispatch and trace it to an I/O sink). It yields
// OBSERVATIONS; the opaque→cache→LLM ladder and the glob grounding stay in the agnostic engine.
//
// LAZY (the teacher principle): a method is carrier-traced only when it's actually CALLED with a literal
// key. Resolution is PINNED-only (RESOLVED), so an unknown-receiver by-name match never fabricates a
// channel — precision-first, like the rest of the floor.
import { getParser } from "../../core/treesitter.js";
import { buildRubyIndex, inferAssignments, resolveMethodCall, resolveSelfCall, type RubyIndex } from "./dispatch.js";
import { traceCarrier, methodSource as rubyMethodSource, type CarrierEffect, type Direction } from "./carrier_trace.js";
import type { CarrierObservation, CarrierProvider } from "../../codebase/coupling/carrier/provider.js";

const _field = (n: any, f: string): any => n.childForFieldName?.(f) ?? null;

// TEACHER 2 (string analysis) — a string-literal key, OR a PARTIAL family pattern recovered from an
// interpolated string: `"Data/Text/#{lang}.dat"` → `Data/Text/*.dat` (each `#{…}` hole becomes `*`). A
// pure literal is `partial:false`; an interpolated one `partial:true`. A string with NO literal content
// (`"#{x}"`) yields no recoverable key (fully dynamic — teacher 3 / blindspot).
function _keyPattern(n: any): { value: string; partial: boolean } | null {
  if (!n || n.type !== "string") return null;
  let val = "", partial = false, hasLiteral = false;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c.type === "interpolation") { val += "*"; partial = true; }
    else if (c.type === "escape_sequence") return null;            // give up on escapes
    else if (c.type.includes("content")) { val += c.text; hasLiteral = true; }
  }
  if (!hasLiteral) return null;
  return { value: val.replace(/\*+/g, "*"), partial };             // collapse adjacent holes
}

function _collectCalls(node: any, out: any[] = []): any[] {
  if (node.type === "call") out.push(node);
  for (let i = 0; i < node.namedChildCount; i++) _collectCalls(node.namedChild(i), out);
  return out;
}

// The enclosing class FQN for a call node (so a receiver-less call resolves against the right self).
function _enclosingClass(index: RubyIndex, file: string, row: number): string {
  let best = "Object", bestSpan = Infinity;
  for (const info of index.values()) {
    if (info.file !== file) continue;
    for (const d of info.methods.values()) { if (d.file === file && d.line <= row && (row - d.line) < bestSpan) { best = info.fqn; bestSpan = row - d.line; } }
  }
  return best;
}

// traceCarrier memo, per repo index (lazy: only traced methods are computed). Keyed by the index object
// so a fresh `buildIndex` (a new run / a drift rebuild) gets a fresh memo.
const _dirCacheOf = new WeakMap<RubyIndex, Map<string, CarrierEffect>>();
function _dirCache(index: RubyIndex): Map<string, CarrierEffect> {
  let m = _dirCacheOf.get(index);
  if (!m) { m = new Map(); _dirCacheOf.set(index, m); }
  return m;
}

async function scanFile(repo: string, index: RubyIndex, file: string, text: string): Promise<CarrierObservation[]> {
  const parser = await getParser("ruby");
  if (!parser) return [];
  let root: any;
  try { root = parser.parse(text).rootNode; } catch { return []; }
  const assigns = inferAssignments("", root);
  const dirCache = _dirCache(index);
  const out: CarrierObservation[] = [];

  const effOf = async (cls: string, method: string): Promise<CarrierEffect> => {
    const k = `${cls}#${method}`;
    if (dirCache.has(k)) return dirCache.get(k)!;
    const eff = await traceCarrier(repo, index, cls, method);
    dirCache.set(k, eff);
    return eff;
  };

  for (const call of _collectCalls(root)) {
    const mname = _field(call, "method")?.text;
    if (!mname) continue;
    // the key = a string argument (literal, or an interpolated family pattern via teacher 2); path is
    // usually arg0, but accept the first string-shaped arg.
    const args = _field(call, "arguments");
    let key: { value: string; partial: boolean } | null = null;
    if (args) for (let i = 0; i < args.namedChildCount; i++) { const k = _keyPattern(args.namedChild(i)); if (k) { key = k; break; } }
    if (!key) continue;
    const recv = _field(call, "receiver");
    const row = call.startPosition.row;
    const cands = recv
      ? resolveMethodCall(index, recv.text, mname, assigns, row, [])
      : resolveSelfCall(index, _enclosingClass(index, file, row), mname);
    const pinned = cands.filter((c) => c.tier === "RESOLVED" && index.has(c.className));
    for (const c of pinned) {
      const eff = await effOf(c.className, c.method);
      if (eff.codeLoad) continue;   // a code-loader (require/eval) — not a DATA channel
      const dir: Direction | null = eff.directions.includes("write") ? "write" : eff.directions.includes("read") ? "read" : null;
      if (dir) { out.push({ value: key.value, partial: key.partial, line: row, callee: { className: c.className, method: c.method }, direction: dir }); continue; }
      // deterministic tracing left it OPAQUE (delegates externally, no sink) → a teacher-3 candidate.
      // The engine runs the cache→LLM ladder on these; a non-carrier (pure computation) yields nothing.
      if (eff.external && eff.directions.length === 0)
        out.push({ value: key.value, partial: key.partial, line: row, callee: { className: c.className, method: c.method }, direction: null });
    }
  }
  return out;
}

export const RUBY_CARRIER: CarrierProvider<RubyIndex> = {
  name: "Ruby",
  handles: (file) => file.endsWith(".rb") || file.endsWith(".rake"),
  buildIndex: (repo) => buildRubyIndex(repo),
  scanFile,
  methodSource: (repo, index, className, method) => rubyMethodSource(repo, index, className, method),
};
