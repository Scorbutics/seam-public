// CENTER-FIRST detection (repo-wide, NO grow, NO anchor). Picking a concern's mechanism from an intent PHRASE
// is a SEMANTIC mapping — and keyword-matching def NAMES is the wrong primitive for it: a verb like "managed"
// matches management code everywhere, a noun like "bookings" only hits whatever is literally named "booking".
// So we ASK THE LLM to navigate the codebase the way a dev would — pick the DOMAIN DIRECTORY (`core/bookings/`),
// then the mechanism inside it. Two cheap LLM passes (injected; the CLI wires them). Offline (no judges) falls
// back to a deterministic lexical floor. An agent passes --center and none of this runs (zero LLM).
import { statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { enumerate_defs } from "../scan/index.js";
import { symbolCallers } from "../scan/class_graph.js";
import type { Def } from "../scan/index.js";
import { walk } from "../../core/resolve/walk.js";
import { SKIP_DIRS, endsWithSourceExt } from "../../core/resolve/languages/index.js";
import type { Center } from "./center.js";

export type CenterCandidate = { symbol: string; file: string; kind: string; signature: string; fanIn: number };
// STAGE-2 judge (auto→llm): pick the mechanism def(s) from a bounded, in-scope candidate set.
export type CenterJudge = (intent: string, candidates: CenterCandidate[]) => Promise<string[] | null>;
// STAGE-1 judge (auto→llm): pick the domain directory(ies) the concern is implemented in, from the source tree.
export type DirJudge = (intent: string, dirs: { dir: string; sample: string[] }[]) => Promise<string[] | null>;

// CONVENTIONS/config only — never a mechanism, and NOT per-repo guesses: standard tests, `.d.ts` type-decls.
const _TEST_FILE = /(?:^|\/)(?:tests?|__tests__|e2e|cypress)(?:\/|$)|\.(?:test|spec|cy|e2e-spec|stories|test-samples)\.[jt]sx?$/i;
const _TYPE_DECL = /\.d\.ts$/i;
const _norm = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "");

// The repo's SOURCE directories (dirs holding ≥1 source file), each with a few example basenames so the LLM can
// tell what a package is about. Excludes SKIP_DIRS (walk), tests (unless includeTests) and the dev's --exclude.
function sourceDirs(repo: string, exDirs: string[], includeTests: boolean): { dir: string; sample: string[] }[] {
  const byDir = new Map<string, string[]>();
  for (const [d, files] of walk(repo, SKIP_DIRS)) for (const fn of files) {
    const rel = _norm(relative(repo, join(d, fn)));
    if (!endsWithSourceExt(rel) || _TYPE_DECL.test(rel)) continue;
    if (!includeTests && _TEST_FILE.test(rel)) continue;
    if (exDirs.some((x) => rel === x || rel.startsWith(x + "/") || rel.includes("/" + x + "/"))) continue;
    const dir = _norm(dirname(rel));
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(fn.replace(/\.[^.]+$/, ""));
  }
  return [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, s]) => ({ dir, sample: [...new Set(s)].slice(0, 6) }));
}

// ── the deterministic LEXICAL floor (offline only) — kept minimal; the LLM path above is the real one. ────────
const _STOP = new Set(["how", "are", "is", "the", "a", "an", "of", "to", "in", "and", "or", "for", "with", "on", "by", "do", "does", "we", "this", "that", "what", "where", "which", "from", "when", "been", "being", "its"]);
const _terms = (intent: string) => [...new Set(intent.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !_STOP.has(w)))];
const _camel = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
const _wordHit = (w: string, t: string): boolean => w === t || (Math.min(w.length, t.length) >= 4 && (t.startsWith(w) || w.startsWith(t)));
function _score(d: Def, terms: string[]): number {
  const nameW = _camel(d.name), seg = `${d.enclosing} ${d.file}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let s = 0;
  for (const t of terms) { if (nameW.some((w) => _wordHit(w, t))) s += 3; else if (seg.some((w) => _wordHit(w, t))) s += 1; }
  return s;
}

type RepoOpts = { k?: number; cap?: number; excludeDirs?: string[]; includeTests?: boolean; dirJudge?: DirJudge; judge?: CenterJudge; debug?: (l: string) => void };

export async function detectCentersRepoWide(repo: string, intent: string, opts: RepoOpts = {}): Promise<Center[]> {
  const k = Math.max(1, opts.k ?? 4);
  const exDirs = (opts.excludeDirs ?? []).map((d) => _norm(d).replace(/^\/+|\/+$/g, "")).filter(Boolean);
  const inExcluded = (f: string) => { const p = _norm(f); return exDirs.some((d) => p === d || p.startsWith(d + "/") || p.includes("/" + d + "/")); };
  const structural = (d: Def) => d.kind !== "module" && d.kind !== "enum" && !_TYPE_DECL.test(d.file) && (opts.includeTests || !_TEST_FILE.test(d.file)) && !inExcluded(d.file);

  let callers = new Map<string, string[]>();
  try { callers = await symbolCallers(repo); } catch { /* fan-in 0 */ }

  // STAGE 1 — the LLM picks the domain DIRECTORY(ies). This is the semantic navigation that keyword-recall can't do.
  let scopeDirs: string[] | null = null;
  if (opts.dirJudge) {
    const dirs = sourceDirs(repo, exDirs, !!opts.includeTests);
    if (dirs.length) {
      try { const p = await opts.dirJudge(intent, dirs); if (p && p.length) scopeDirs = p.map(_norm); } catch { /* → lexical floor */ }
      if (scopeDirs) opts.debug?.(`[center-first] LLM scoped to dir(s): ${scopeDirs.join(", ")}`);
    }
  }

  const seen = new Set<string>();
  const dedup = <T extends { d: Def }>(xs: T[]) => xs.filter((x) => { const key = `${x.d.name} ${x.d.file}`; if (seen.has(key)) return false; seen.add(key); return true; });
  let recall: { d: Def; fan: number }[];
  if (scopeDirs) {
    // enumerate ONLY the files UNDER the picked dirs — bypassing enumerate_defs' whole-repo cap (4000), which on a
    // big monorepo hides deep packages (cal.com: `packages/features/bookings/…` sorts past 4000, so it was empty).
    const scopedFiles = new Set<string>();
    for (const [d, files] of walk(repo, SKIP_DIRS)) for (const fn of files) {
      const rel = _norm(relative(repo, join(d, fn)));
      if (!endsWithSourceExt(rel) || _TYPE_DECL.test(rel) || (!opts.includeTests && _TEST_FILE.test(rel)) || inExcluded(rel)) continue;
      if (scopeDirs.some((sd) => { const b = sd.replace(/\/$/, ""); return rel === b || rel.startsWith(b + "/"); })) scopedFiles.add(rel);
    }
    const defs = (await enumerate_defs(repo, 100000, scopedFiles)).filter(structural);
    // the LLM already chose WHERE; the mechanism is a BEAN/SERVICE (a class) or a top-level function — NOT a class
    // METHOD. Offering methods ranked by bare-name fan-in surfaced generic accessors (get/save/toString called
    // 1000× repo-wide via name-collision) and the LLM picked `getMember` over `BookingsBean`. So present only
    // mechanism-level defs: classes/interfaces + top-level functions (empty `enclosing`), never class methods.
    const mechLevel = (d: Def) => d.kind === "class" || d.kind === "interface" || !d.enclosing;
    recall = dedup(defs.filter(mechLevel).map((d) => ({ d, fan: callers.get(d.name)?.length ?? 0 })))
      .sort((a, b) => (Number(b.d.kind === "class" || b.d.kind === "interface") - Number(a.d.kind === "class" || a.d.kind === "interface")) || (b.fan - a.fan))
      .slice(0, opts.cap ?? 60);
  } else {
    // OFFLINE floor — deterministic lexical net (prefix-matched, whole-segment path), whole-repo (capped).
    const defs = (await enumerate_defs(repo)).filter(structural);
    const terms = _terms(intent);
    recall = dedup(defs.map((d) => ({ d, fan: callers.get(d.name)?.length ?? 0, s: _score(d, terms) })).filter((x) => x.s > 0).sort((a, b) => (b.s - a.s) || (b.fan - a.fan))).slice(0, opts.cap ?? 80);
  }
  if (!recall.length) return [];
  opts.debug?.(`[center-first] ${recall.length} candidate(s)${scopeDirs ? " in scope" : " (lexical floor)"}: ${recall.slice(0, 14).map((x) => `${x.d.name}(${x.fan})`).join(", ")}`);

  const cands: CenterCandidate[] = recall.map((x) => ({ symbol: x.d.name, file: x.d.file, kind: x.d.kind, signature: x.d.signature, fanIn: x.fan }));
  let picked = cands;
  if (opts.judge) {
    try { const ids = await opts.judge(intent, cands); if (ids && ids.length) { const set = new Set(ids); const p = cands.filter((c) => set.has(`${c.symbol} ${c.file}`)); if (p.length) picked = p; } } catch { /* → floor */ }
  }
  return picked.slice(0, k).map((c) => ({ id: `${c.file}#${c.symbol}`, file: c.file, symbol: c.symbol, fanIn: c.fanIn }));
}
