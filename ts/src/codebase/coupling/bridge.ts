// TARGETED COUPLING (for the BRIDGE / review-impact). resolveCoupling (index.ts) builds a FULL-repo key
// index (scan EVERY file) to ground ANY anchor's keys — right for a multi-node grow that amortises it,
// WRONG for a one-shot review where we already know the anchor's keys. Here we INVERT it (Brice's "grow
// from the diff"): compute the anchor's keys LOCALLY, then for each value GREP the repo for that exact
// string → only the files that could share it, scan THOSE for the complementary key, ground. O(files that
// mention the key), not O(repo) — fast even cold, no full floor index, no `.seam` warm-up. An anchor with
// NO key returns [] instantly (the common perf/bugfix case), so the bridge pays ~nothing for a change that
// touches no boundary. Split out of coupling/index.ts (the pipeline orchestrator) — this is a self-contained
// second pipeline (targeted grep vs the full-repo GROUND/DRAW/WIRE walk), not a step of the main one.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { type Ctx, makeCtx, available, lang_for, _FUNCLIKE, _CLASS_KINDS, _METHOD_KINDS, _NAME_KINDS, _NAME_LEAVES, _VAR_DECLARATOR } from "../atoms.js";
import { field } from "../../core/treesitter.js";
import { SKIP_DIRS } from "../../core/resolve/languages/index.js";
import { normpath, walkFiles } from "../../core/resolve/walk.js";
import { recordRead } from "../../core/resolve/dep_recorder.js";
import { type KeyHit } from "./types.js";
import { EngineCtx } from "../engine_ctx.js";
import { scan_file_keys, scannableForKeys, kindOf } from "./adapters/index.js";
import { runMatcher, plausibleKeyValue } from "./key_ir.js";
import { listMatchers } from "./key_store.js";
import { isTestFile } from "../../core/resolve/consumers.js";
import { COUPLING } from "./config.js";

const READER_CAP = COUPLING.readerCap;   // materialise at most this many complement nodes per key
const stem = (p: string) => { const b = basename(p); const d = b.lastIndexOf("."); return d > 0 ? b.slice(0, d) : b; };

// The declared NAME of a def — the tree-sitter `name` FIELD first (NOT a leading return type: a Java/C++
// `SubList paginate(...)` writes the type before the name, so a positional scan grabbed `SubList`), then the
// C/C++ declarator-field chain, then a positional fallback. Mirrors scan/ast_units._name_of — duplicated here
// because coupling can't import scan (scan→coupling already exists; importing back would cycle).
function _name_of(ctx: Ctx, node: any): string | null {
  const nf = node.childForFieldName?.("name");
  if (nf) return ctx.text(nf);
  let x: any = node.childForFieldName?.("declarator");
  for (let g = 0; x && g < 16; g++) {
    if (_NAME_LEAVES.has(x.type)) return ctx.text(x);
    x = x.childForFieldName?.("declarator") ?? null;
  }
  for (const c of ctx.children(node)) if (_NAME_KINDS.has(c.type)) return ctx.text(c);
  return null;
}

// The named function/method/class enclosing `line` in a complement file (smallest wins), or a module
// stub for a top-level access (e.g. a Next.js `export const GET = …` route). Lazy — only ≤CAP parsed.
export async function complement_unit(repo: string, file: string, line: number): Promise<{ symbol: string; kind: string; start: number; end: number }> {
  const fallback = { symbol: stem(file), kind: "module", start: line, end: line };
  const lang = lang_for(file);
  if (!lang || !available()) return fallback;
  let ctx: Ctx | null;
  try { const content = readFileSync(join(repo, file), "utf-8"); recordRead(file, content); ctx = await makeCtx(content, lang); } catch { return fallback; }
  if (!ctx) return fallback;
  let best: { symbol: string; kind: string; start: number; end: number } | null = null;
  const offer = (nm: string | null, kind: string, s: number, e: number) => {
    if (!nm || s > line || line > e) return;
    if (!best || (e - s) < (best.end - best.start)) best = { symbol: nm, kind, start: s, end: e };
  };
  for (const n of ctx.collect(ctx.root, (k) => _FUNCLIKE.has(k) || _CLASS_KINDS.has(k) || _VAR_DECLARATOR.has(k))) {
    // A `const f = (…) => {…}` / `const f = function(){}` funclike carries NO name of its own — the name lives
    // on the DECLARATOR (exactly the case scan/ast_units._named_units handles with its own _VAR_DECLARATOR
    // branch; duplicated rather than imported because coupling must not import scan — see _name_of above).
    // Without it, a complement whose access sits inside a named arrow (a client fetch wrapper:
    // `export const createBooking = async (d) => post("/api/book/event", d)`) fell back to the MODULE stub,
    // and a module stub's symbol is the file STEM — not a declared symbol — so the grow's up-climb from that
    // complement resolved NOTHING and the client's own callers (the React hook that triggers the request)
    // were unreachable at any budget. Naming the unit is what lets the climb continue past the crossing.
    if (_VAR_DECLARATOR.has(n.type)) {
      const ch = ctx.children(n);
      const fl = ch.find((c: any) => _FUNCLIKE.has(c.type));
      if (fl && ch.length && _NAME_KINDS.has(ch[0].type)) { const [s, e] = ctx.span(fl); offer(ctx.text(ch[0]), "function", s, e); }
      continue;
    }
    const [s, e] = ctx.span(n);
    offer(_name_of(ctx, n), _CLASS_KINDS.has(n.type) ? "class" : _METHOD_KINDS.has(n.type) ? "method" : "function", s, e);
  }
  return best ?? fallback;
}

// The [start,end] line span of a NAMED symbol in a file (the reverse of complement_unit: name → span, not line →
// unit). Used by the `writers` shape query to scope the center's own table READS to its method body. null when the
// symbol isn't found (or no tree-sitter) → the caller falls back to the whole file.
export async function symbol_span(repo: string, file: string, symbol: string): Promise<[number, number] | null> {
  const lang = lang_for(file);
  if (!lang || !available()) return null;
  let ctx: Ctx | null;
  try { const content = readFileSync(join(repo, file), "utf-8"); recordRead(file, content); ctx = await makeCtx(content, lang); } catch { return null; }
  if (!ctx) return null;
  let best: [number, number] | null = null;
  for (const n of ctx.collect(ctx.root, (k) => _FUNCLIKE.has(k) || _CLASS_KINDS.has(k))) {
    if (_name_of(ctx, n) !== symbol) continue;
    const [s, e] = ctx.span(n);
    if (!best || (e - s) < (best[1] - best[0])) best = [s, e];   // tightest match if the name recurs
  }
  return best;
}

// COLUMN-GRAIN for the `writers` shape query (TS/ORM convention, isolated per CLAUDE.md). The coupling floor keys
// the TABLE (`booking`); to refine "who writes the state a reader FILTERS on" we read the actual COLUMNS an ORM
// access touches — a write's `data` object keys, a read's `where` object keys (descending AND/OR/NOT). Given the
// file+line of a `<recv>.<table>.<verb>({…})` access, return {writes, reads} column sets. Empty ⇒ opaque (no
// `{data|where}` object arg we could parse), and the caller then KEEPS the writer marked unverified — never drops
// a real write just because its columns were unreadable. STRUCTURAL (AST keys), never a name guess.
const _WHERE_LOGIC = new Set(["AND", "OR", "NOT"]);
const _unquote = (s: string) => s.replace(/^["'`]|["'`]$/g, "");
function _objColumns(ctx: Ctx, obj: any | null): string[] {
  if (!obj || obj.type !== "object") return [];
  const cols: string[] = [];
  for (const p of ctx.children(obj)) {
    if (p.type !== "pair") continue;
    const keyN = field(p, "key");
    const key = keyN ? _unquote(ctx.text(keyN)) : "";
    if (!key) continue;
    if (_WHERE_LOGIC.has(key)) {                          // AND/OR (array of objs) | NOT (obj) → descend one level
      const val = field(p, "value");
      const subs = val?.type === "array" ? ctx.children(val).filter((c: any) => c.type === "object")
                 : val?.type === "object" ? [val] : [];
      for (const so of subs) cols.push(..._objColumns(ctx, so));
    } else cols.push(key);
  }
  return [...new Set(cols)];
}
function _prop(ctx: Ctx, obj: any, name: string): any | null {
  for (const p of ctx.children(obj)) {
    if (p.type !== "pair") continue;
    const k = field(p, "key");
    if (k && _unquote(ctx.text(k)) === name) return field(p, "value");
  }
  return null;
}
export async function accessColumns(repo: string, file: string, line: number, ctxCache?: Map<string, Ctx | null>): Promise<{ writes: string[]; reads: string[] }> {
  const empty = { writes: [] as string[], reads: [] as string[] };
  const lang = lang_for(file); if (!lang || !available()) return empty;
  let ctx = ctxCache?.get(file);
  if (ctx === undefined) {
    try { const content = readFileSync(join(repo, file), "utf-8"); ctx = await makeCtx(content, lang); } catch { ctx = null; }
    ctxCache?.set(file, ctx);
  }
  if (!ctx) return empty;
  // the INNERMOST call_expression containing the access line that carries a `{data|where}` config object = the ORM call.
  let best: { writes: string[]; reads: string[] } | null = null, bestSize = Infinity;
  for (const call of ctx.collect(ctx.root, (k) => k === "call_expression")) {
    const [s, e] = ctx.span(call);
    if (line < s || line > e || (e - s) >= bestSize) continue;
    const args = field(call, "arguments");
    const cfg = args && args.namedChildCount ? args.namedChild(0) : null;
    if (!cfg || cfg.type !== "object") continue;
    const writes = _objColumns(ctx, _prop(ctx, cfg, "data"));
    const reads = _objColumns(ctx, _prop(ctx, cfg, "where"));
    if (writes.length || reads.length) { best = { writes, reads }; bestSize = e - s; }
  }
  return best ?? empty;
}

// UNCAPPED anchor counterparts — the anchor's own shared keys (span-scoped) × the repo-wide FLOOR's other side.
// `couplingOtherSides` (the targeted grep pipeline below) is CAPPED (_TARGETED_CAND_CAP/READER_CAP) so it can miss
// a real counterpart on a hub key; the floor index is complete. Used where completeness matters more than the
// bounded cost (the `coupling` shape, and reachability's data hops). Dynamic imports break the index.ts↔bridge.ts cycle.
export interface AnchorCounterpart { file: string; symbol: string; line: number; kind: string; value: string; role: "reads" | "writes" }
export async function anchorCounterparts(repo: string, file: string, symbol: string | null, ctx?: EngineCtx): Promise<AnchorCounterpart[]> {
  const { floor_base_index, otherSide, scan_file_keys } = await import("./index.js");
  const { SKIP_DIRS: SD } = await import("../../core/resolve/languages/index.js");
  let text: string;
  try { text = readFileSync(join(repo, file), "utf-8"); } catch { return []; }
  const span = symbol ? await symbol_span(repo, file, symbol) : null;
  const inSpan = (l: number) => !span || (l >= span[0] && l <= span[1]);
  const own = new Map<string, { kind: string; value: string; reads: boolean; writes: boolean }>();
  for (const h of scan_file_keys(file, text)) {
    if (!inSpan(h.line)) continue;
    const k = `${h.kind} ${h.value}`;
    const e = own.get(k) ?? { kind: h.kind, value: h.value, reads: false, writes: false };
    if (h.produces) e.writes = true; else e.reads = true;
    own.set(k, e);
  }
  if (!own.size) return [];
  const idx = floor_base_index(repo, SD, ctx ?? new EngineCtx());
  const out: AnchorCounterpart[] = [];
  const seen = new Set<string>();
  const anchorNorm = normpath(file);
  for (const e of own.values()) {
    // the anchor READS a key → its counterparts are the WRITERS (otherSide produces:false ⇒ producers), and vice versa.
    for (const [role, produces] of [["writes", false], ["reads", true]] as const) {
      if (role === "writes" && !e.reads) continue;
      if (role === "reads" && !e.writes) continue;
      for (const acc of otherSide(idx, e.kind, e.value, produces)) {
        if (normpath(acc.file) === anchorNorm) continue;
        const unit = await complement_unit(repo, acc.file, acc.line);
        const dk = `${acc.file}#${unit.symbol}#${e.kind} ${e.value}#${role}`;
        if (seen.has(dk)) continue;
        seen.add(dk);
        out.push({ file: acc.file, symbol: unit.symbol, line: acc.line, kind: e.kind, value: e.value, role });
      }
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return out;
}

export interface CouplingOtherSide { kind: string; value: string; file: string; symbol: string; edgeKind: string; provenance: string }

// Files containing `value` literally — ripgrep (gitignore-aware, instant) with a walk+substring fallback. The
// value is a plausible key (identifier/path), matched as a FIXED string, so there's no regex/shell hazard.
//
// TOTALLY ORDERED (path ascending) — NOT a ranking, a DETERMINISM contract. `rg -l` walks the tree on a THREAD
// POOL, so its emission order is a RACE: the same repo + same value yields a different permutation every run.
// Every caller then CAPS the list (the targeted candidate cap, files-per-class), which turned a bounded scan
// into a LOTTERY — a different subset survived the cap each run, so the SAME query answered differently
// (measured on cal.com: `getBusyTimes` reported 1..6 cross-stack crossings across identical cold runs, each run's
// set a different prefix of a different permutation). The result is a SET semantically, so normalise it to its
// canonical order in ONE place and every caller's budget becomes order-independent. Same set, fixed order — no
// re-ranking, no recall trade. (The walk fallback is already ordered — walk.ts sorts readdir.)
export function grepFiles(repo: string, value: string): string[] {
  try {
    const r = spawnSync("rg", ["-l", "-F", "--no-messages", "--", value, "."], { cwd: repo, encoding: "utf-8", maxBuffer: 1 << 27 });
    if (r.status === 0 && r.stdout) return r.stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, "")).sort();
    if (r.status === 1) return [];   // ripgrep ran, no matches
  } catch { /* rg absent → fallback */ }
  const out: string[] = [];          // fallback: read+includes (no masking/adapters → far cheaper than the floor scan)
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, scannableForKeys)) if (text.includes(value)) out.push(rel);
  return out.sort();
}

// COST is bounded by the SCAN BUDGET below, never by a cap on the candidate LIST. The old `_TARGETED_CAND_CAP
// = 200` capped the INPUT (the first 200 grep hits) when its purpose was capping WORK — so on a hot key the
// answer was decided by where a complement happened to fall in path order, not by what exists. Measured on
// cal.com `db-table booking` (1147 candidates, 26 real complementary writers): only 2 of the 26 sit inside the
// first 200, so the capped pipeline stably reported 2 of the READER_CAP=6 it is allowed to materialise. The
// 6th complement sits at candidate #462 — i.e. the READER_CAP break ALREADY bounds the walk on any key that
// has complements; the input cap only ever truncated the answer. What genuinely needs a bound is a key with
// FEW complements over MANY candidates (the loop then walks the whole list), so bound THAT directly: a
// per-run budget of candidate FILE SCANS, consumed in the grep order (which is total — see grepFiles), so the
// stopping point is a pure function of the repo. Exhausting it is TRUNCATION and is reported (see
// `ctx.couplingTruncations` → the renderer's cross-stack note), never a silent drop.

// The OTHER SIDE of each coupling the anchor SYMBOL touches — resolved by targeted value-grep, not a full
// index. `available()`-gated (needs tree-sitter for the span + complement unit). Degrades to [] on any miss.
export async function couplingOtherSides(
  repo: string, anchorFile: string, symbol: string,
  opts: { llm?: boolean; model?: string; claudeBin?: string | null } = {}, ctx: EngineCtx = new EngineCtx(),
): Promise<CouplingOtherSide[]> {
  if (!available()) return [];
  let anchorText: string;
  try { anchorText = readFileSync(join(repo, anchorFile), "utf-8"); } catch { return []; }

  // the symbol's span (lo..hi) — scope the anchor keys to the changed symbol, not the whole file.
  let lo = 0, hi = Number.MAX_SAFE_INTEGER;
  const lang = lang_for(anchorFile);
  if (lang) {
    const actx = await makeCtx(anchorText, lang);
    if (actx) for (const n of actx.collect(actx.root, (k) => _FUNCLIKE.has(k) || _CLASS_KINDS.has(k))) {
      if (_name_of(actx, n) === symbol) { [lo, hi] = actx.span(n); break; }
    }
  }
  const inSpan = (line: number) => line >= lo && line <= hi;

  // 1. ANCHOR KEYS — local only (floor + learned matchers + LLM-proposed), span-filtered + deduped.
  const matchers = listMatchers(repo).map((x) => x.matcher);
  // The file's full key scan (floor + matchers) is the same for every symbol IN that file — cache it on the
  // ctx so a multi-symbol bridge run scans each file ONCE, not once per changed symbol (the measured redundancy).
  let fileKeys = ctx.fileKeyScan.get(anchorFile);
  if (!fileKeys) {
    fileKeys = scan_file_keys(anchorFile, anchorText).slice();
    for (const m of matchers) for (const h of await runMatcher(m, anchorFile, anchorText)) fileKeys.push(h);
    ctx.fileKeyScan.set(anchorFile, fileKeys);
  }
  const anchorKeys = new Map<string, { kind: string; value: string; produces: boolean }>();
  const addKey = (h: KeyHit) => { if (inSpan(h.line) && plausibleKeyValue(h.value)) anchorKeys.set(`${h.kind} ${h.value} ${h.produces}`, { kind: h.kind, value: h.value, produces: h.produces }); };
  for (const h of fileKeys) addKey(h);
  if (opts.llm) { const lk = await import("./llm_key_index.js"); for (const h of await lk.anchorProposedKeys(repo, anchorFile, anchorText, { llm: true, model: opts.model, claudeBin: opts.claudeBin }, ctx)) addKey({ ...h, line: lo }); }
  if (!anchorKeys.size) return [];   // no boundary in the anchor → nothing to resolve, instantly

  // 2-4. per key: GREP for the value → candidate files → scan for the COMPLEMENTARY key → ground.
  const anchorNorm = normpath(anchorFile);
  const out: CouplingOtherSide[] = [];
  const seen = new Set<string>();
  for (const key of anchorKeys.values()) {
    // EXCLUDE test files from the coupling crossing candidates — a `.integration-test`/`.e2e-spec`/seed file that
    // writes the subject table (`booking`) is NOT a real co-writer/reader of the flow, it's a fixture. The grow
    // excludes tests everywhere else by default; this path (grep → candidate scan) was the last one that didn't, so
    // an intent's subject write-set got flooded by integration-test writers (cal.com `booking`) and the real
    // producers were crowded out. Structural (path shape), matches the engine-wide default test exclusion.
    // `grepFiles` is TOTALLY ORDERED (see there), so the READER_CAP break and the scan budget below consume a
    // fixed prefix of a fixed set: the crossing this resolves is the same on every run.
    const candidates = grepFiles(repo, key.value).filter((f) => normpath(f) !== anchorNorm && scannableForKeys(f) && !isTestFile(f));
    let materialised = 0, walked = 0;
    for (const cand of candidates) {
      if (materialised >= READER_CAP) break;
      if (ctx.candidateScanBudget <= 0) break;   // budget exhausted → truncation, recorded below
      walked++;
      let text: string; try { text = readFileSync(join(repo, cand), "utf-8"); } catch { continue; }
      // Per-FILE key scan, memoised on the ctx — the SAME cache the anchor scan uses above. An anchor carries
      // several keys whose grep hits overlap heavily (cal.com `get.handler.ts`: 4578 candidate scans across 5
      // keys but only 3140 DISTINCT files), and the bridge is called once per changed symbol, so without this
      // the uncapped walk re-reads and re-parses the same files many times over.
      let candKeys = ctx.fileKeyScan.get(cand);
      if (!candKeys) {
        candKeys = scan_file_keys(cand, text).slice();
        for (const m of matchers) for (const h of await runMatcher(m, cand, text)) candKeys.push(h);
        ctx.fileKeyScan.set(cand, candKeys);
        ctx.candidateScanBudget--;   // only a FRESH scan costs; a cache hit is free (so the budget bounds WORK, not list length)
      }
      const match = candKeys.find((h) => h.kind === key.kind && h.value === key.value && h.produces !== key.produces);   // the COMPLEMENTARY role on the same key
      if (!match) continue;
      const unit = await complement_unit(repo, cand, match.line);
      const dedup = `${cand}#${unit.symbol}#${key.kind} ${key.value}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      materialised++;
      const adapter = kindOf(key.kind);
      out.push({ kind: key.kind, value: key.value, file: cand, symbol: unit.symbol,
        edgeKind: match.produces ? adapter.produceEdge : adapter.consumeEdge, provenance: "RESOLVED_PARTIAL" });
    }
    // HONESTY — the walk stopped before the candidate list was exhausted, so the repo may hold more counterparts
    // on this key than we report. Say so (the caller renders it as a cross-stack note) instead of presenting a
    // truncated set as complete. Two distinct causes, both bounded and deterministic: READER_CAP (this key had
    // MORE complements than we materialise) and the scan budget (we ran out of work allowance).
    if (walked < candidates.length) {
      const reason = materialised >= READER_CAP ? "reader-cap" : "scan-budget";
      ctx.couplingTruncations.push({ kind: key.kind, value: key.value, scanned: walked, total: candidates.length, reason });
    }
  }
  return out;
}
