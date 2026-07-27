// RUST-CORE STRANGLER (Phase 1) — route the deterministic STRUCTURAL grow through the Rust addon
// (rust/seam_core.node) instead of the TS `_growToTerminalsImpl`. Enabled by SEAM_RUST_CORE=1. The addon does the
// intent-free structural grow + coupling (floor + learned-matcher REPLAY); it is byte-identical to the TS grow in
// structural mode (SEAM_GROW_STRUCTURAL), which is the config this path forces. Rendering + flywheel DISCOVERY stay
// in TS for now (later phases move discovery into Rust). The converter maps the addon's GraphDto onto the exact
// ResolvedGraph `data` shape that `from_resolved_graph` consumes.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveStructuralKnobs } from "./structural_knobs.js";

let _addon: any | undefined; // lazy singleton

function addonPath(): string {
  if (process.env.SEAM_RUST_CORE_PATH) return process.env.SEAM_RUST_CORE_PATH;
  // default: <repo>/rust/seam_core.node, relative to this module (ts/src/codebase/grow/rust_core.ts)
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../rust/seam_core.node");
}

// DEFAULT-ON. An opt-in flag is a trap for the caller — a harness that forgets it measures the slow TS grow and
// reports that as Seam's speed — so this was always meant to end up here. The first attempt at the flip was
// REVERTED because 41 grow/coupling/wavefront tests failed on the addon path; those had four root causes, all
// now closed: the containment options never crossed the napi boundary (the addon hard-coded hub fan / up-hop /
// exclusions), `tableAccess` was stubbed on a false premise, the CLI rewrote every grow to `structuralGrow:
// true` (so a DETECTION grow came back with a fraction of its mechanisms), and bun's `process.env` writes never
// reached Rust's `std::env`.
//
// The flip is guarded rather than unconditional. `grow_to_terminals` routes to the addon only for a
// DETERMINISTIC, intent-free grow whose language the addon can actually parse (both the anchor's and the rest
// of the repo's) — an intent-shaped grow has no embedding field over there, and an unvendored grammar returns
// an empty AST rather than an error. Everything else stays on the TS engine, which remains the reference
// implementation, not a fallback. `=0` forces the TS path outright.
export function rustCoreEnabled(): boolean {
  return process.env.SEAM_RUST_CORE !== "0" && process.env.SEAM_RUST_CORE !== "false";
}

// Can the addon PARSE this file's language? The Rust core links only a subset of the grammars the TS engine
// loads as wasm (java/typescript/tsx/javascript today), and a missing grammar fails SILENTLY: tree-sitter
// returns no AST, every scan comes back empty, and the grow yields a well-formed graph missing whatever it
// could not read. Measured on a two-file Ruby repo: the TS engine reaches both files, the addon reaches the
// anchor alone — indistinguishable, to a caller, from "this symbol has no consumers". So the router asks first
// and leaves an unparseable language on the TS path. Unknown addon (older build without the probe) → assume NO,
// because the failure mode of guessing wrong is a confidently wrong answer.
export function rustCanParse(file: string): boolean {
  try {
    const addon = loadAddon();
    return typeof addon.canParse === "function" ? !!addon.canParse(file) : false;
  } catch {
    return false;
  }
}

// Can the addon serve grows for this REPO at all — i.e. is every source language in it one the addon can read?
// The per-file check above gates the ANCHOR, which settles a single-language repo; it does NOT stop a grow that
// starts in TypeScript and REACHES a Ruby file, which drops out just as silently. Memoised per repo because the
// answer is a property of the checkout, and the underlying walk is the same cached one the grow already does.
const _repoOk = new Map<string, boolean>();
export function rustCanServeRepo(repo: string): boolean {
  let ok = _repoOk.get(repo);
  if (ok === undefined) {
    try {
      const addon = loadAddon();
      // No probe (an older addon build) → NO. Guessing wrong here yields a confidently incomplete answer.
      if (typeof addon.unparseableLanguages !== "function") ok = false;
      else {
        const missing: string[] = addon.unparseableLanguages(repo) ?? [];
        ok = missing.length === 0;
        if (!ok && process.env.SEAM_FP_DEBUG)
          process.stderr.write(`[grow] rust-core OFF for this repo — unvendored grammar(s): ${missing.join(", ")}\n`);
      }
    } catch { ok = false; }
    _repoOk.set(repo, ok);
  }
  return ok;
}

// test seam: the capability is memoised per repo, so a hermetic test that rewrites a repo must clear it.
export function _resetRustRepoCapability(): void { _repoOk.clear(); }

export function loadAddon(): any {
  if (_addon === undefined) {
    const require = createRequire(import.meta.url);
    _addon = require(addonPath());
  }
  return _addon;
}

// Convert the addon's GraphDto → the TS ResolvedGraph `data`. Fields mirror scan/graph.ts:ResolvedGraph and the
// per-node/edge shapes from_resolved_graph reads (id/symbol/kind/file/range/enclosing/complexity/direction/hub;
// from/to/kind/provenance/line/op). `coupling` is preserved (raw-data consumers read it) though the IR drops it.
function toResolvedGraph(dto: any): any {
  const nodes = (dto.nodes ?? []).map((n: any) => {
    const node: any = {
      id: n.id, symbol: n.symbol, kind: n.kind, file: n.file,
      range: n.range, enclosing: n.enclosing, complexity: n.complexity,
    };
    if (n.coupling) node.coupling = true;
    if (n.direction != null) node.direction = n.direction;
    if (n.hub != null) node.hub = { reason: n.hub.reason, fan: n.hub.fan, sampleConsumers: n.hub.sampleConsumers ?? n.hub.sample_consumers ?? [] };
    return node;
  });
  const edges = (dto.edges ?? []).map((e: any) => {
    const edge: any = { from: e.from, to: e.to, kind: e.kind, provenance: e.provenance };
    if (e.line != null) edge.line = e.line;
    if (e.op != null) edge.op = e.op;
    return edge;
  });
  const blindspots = (dto.blindspots ?? []).map((b: any) => ({
    node: b.node, mechanism: b.mechanism, evidence: b.evidence,
    candidates: b.candidates ?? [], persists: b.persists ?? false,
  }));
  const data: any = {
    version: 1,
    anchor: { id: dto.anchorId ?? dto.anchor_id, symbol: dto.anchorSymbol ?? dto.anchor_symbol, file: dto.anchorFile ?? dto.anchor_file, range: dto.anchorRange ?? dto.anchor_range },
    language: dto.language,
    resolutionQuality: "FULL",
    depth: 1,
    complete: true,
    nodes, edges, blindspots,
    // PLAIN OBJECTS, never the napi values themselves. `merge_resolved` starts with `structuredClone(base)`,
    // and a value handed straight back from the addon is not cloneable — it throws "The object can not be
    // cloned", which the concern path swallows in a `catch` and silently keeps the un-merged region.
    unresolved: (dto.unresolved ?? []).map((u: any) => ({ ...u })),
  };
  const anchors = dto.anchors;
  if (anchors && anchors.length) data.anchors = anchors.map((x: any) => (x && typeof x === "object" ? { ...x } : x));
  // The FRONTIER is the case that actually bit: it is empty on a structural grow (the tier rule is what fills
  // it), so every Rust grow cloned fine until the intent wave landed — then the booking-app concern re-anchor
  // threw, kept its 11-node point region instead of the merged 33, and looked like a containment bug in the
  // ported wave. Spread each entry into a plain object like nodes/edges/blindspots already are.
  const frontier = dto.frontier;
  if (frontier && frontier.length) data.frontier = frontier.map((f: any) => ({ ...f }));
  return data;
}

// Mirror the host's SEAM_* env into the addon's process env before every call. bun's `process.env` is a JS-side
// object, so a runtime flag flip never reaches Rust's `std::env` — without this the addon answers under the
// environment it saw at process START, which is both a divergence from the TS engine (it re-reads process.env
// per call) and a cache hazard (seam_env_snapshot keys the answer cache on those same vars). Cheap enough to do
// unconditionally: it is a few dozen string compares, and skipping it when "nothing changed" would require
// tracking exactly the state this exists to distrust.
function syncEnv(addon: any): void {
  addon.syncSeamEnv(Object.entries(process.env).filter(([k, v]) => k.startsWith("SEAM_") && v !== undefined) as [string, string][]);
}

// The Rust structural grow. Returns [data, history] matching grow_to_terminals. History is diagnostic-only for
// rendering; flagTruncation "unfollowable" blindspots are synthesized here from the addon's build-failed frontier
// points (cutBy === "build-failed"), preserving the TS truncation-honesty behavior.
export function growViaRust(repo: string, anchorFile: string, symbol: string, opts: any = {}): [any, any[]] {
  const addon = loadAddon();
  syncEnv(addon);
  // The containment knobs are resolved on THIS side (opts → env → default) and handed over as finished values;
  // the Rust core holds no defaulting logic, so the two engines cannot disagree about what a knob means.
  const k = resolveStructuralKnobs(opts, !!opts.ctx?.stableFloor, false);
  const dto = addon.growToTerminals(repo, anchorFile, symbol, opts.dataCoupling !== false, k);
  // The addon answer-caches internally (grow-v1 shards) instead of going through the TS `cachedGrow`, so it
  // reports its warm-path verdict back and we emit the SAME line cachedGrow does — through process.stderr, which
  // is both the TS shell's job and the only stream a caller intercepting process.stderr.write can observe.
  if (process.env.SEAM_FP_DEBUG && dto?.cacheVerdict)
    process.stderr.write(`[grow] ${anchorFile} ${dto.cacheKey} epoch=${dto.cacheEpoch} ${dto.cacheVerdict}\n`);
  const data = toResolvedGraph(dto);
  // THE MOVE HISTORY, from the addon rather than reconstructed. It used to be synthesized here from the
  // build-failed frontier points under `flagTruncation`, which meant an ordinary grow returned an EMPTY
  // history — so a grow that expanded 40 moves looked, to a caller reading `hist.length`, like one that never
  // ran. Plain objects (not the napi values) because callers merge these into cloneable structures.
  const history: any[] = ((dto.history ?? []) as any[]).map((h) => {
    const rec: any = { node: h.node, added: h.added };
    if (h.skipped) rec.skipped = h.skipped;
    return rec;
  });
  return [data, history];
}
