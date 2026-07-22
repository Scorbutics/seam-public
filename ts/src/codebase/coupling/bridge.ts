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
import { type Ctx, makeCtx, available, lang_for, _FUNCLIKE, _CLASS_KINDS, _METHOD_KINDS, _NAME_KINDS, _NAME_LEAVES } from "../atoms.js";
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
  for (const n of ctx.collect(ctx.root, (k) => _FUNCLIKE.has(k) || _CLASS_KINDS.has(k))) {
    const [s, e] = ctx.span(n);
    if (s > line || line > e) continue;
    const nm = _name_of(ctx, n);
    if (!nm) continue;
    if (!best || (e - s) < (best.end - best.start)) {
      best = { symbol: nm, kind: _CLASS_KINDS.has(n.type) ? "class" : _METHOD_KINDS.has(n.type) ? "method" : "function", start: s, end: e };
    }
  }
  return best ?? fallback;
}

export interface CouplingOtherSide { kind: string; value: string; file: string; symbol: string; edgeKind: string; provenance: string }

// Files containing `value` literally — ripgrep (gitignore-aware, instant) with a walk+substring fallback. The
// value is a plausible key (identifier/path), matched as a FIXED string, so there's no regex/shell hazard.
export function grepFiles(repo: string, value: string): string[] {
  try {
    const r = spawnSync("rg", ["-l", "-F", "--no-messages", "--", value, "."], { cwd: repo, encoding: "utf-8", maxBuffer: 1 << 27 });
    if (r.status === 0 && r.stdout) return r.stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, ""));
    if (r.status === 1) return [];   // ripgrep ran, no matches
  } catch { /* rg absent → fallback */ }
  const out: string[] = [];          // fallback: read+includes (no masking/adapters → far cheaper than the floor scan)
  for (const { rel, text } of walkFiles(repo, SKIP_DIRS, scannableForKeys)) if (text.includes(value)) out.push(rel);
  return out;
}

const _TARGETED_CAND_CAP = 200;   // bound the candidate scan for a hot value (a common table name); the relevance floor dampens the rest

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
    const candidates = grepFiles(repo, key.value).filter((f) => normpath(f) !== anchorNorm && scannableForKeys(f) && !isTestFile(f)).slice(0, _TARGETED_CAND_CAP);
    let materialised = 0;
    for (const cand of candidates) {
      if (materialised >= READER_CAP) break;
      let text: string; try { text = readFileSync(join(repo, cand), "utf-8"); } catch { continue; }
      const candKeys: KeyHit[] = scan_file_keys(cand, text);
      for (const m of matchers) for (const h of await runMatcher(m, cand, text)) candKeys.push(h);
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
  }
  return out;
}
