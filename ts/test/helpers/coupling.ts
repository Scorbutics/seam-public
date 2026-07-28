// THE COUPLING FLOOR, over the addon. The TypeScript engine these tests used to import is gone; the floor,
// the ground index and the route-matching predicates are `seam-couple`'s. The napi boundary carries flat
// string rows (it cannot carry a Map or an optional field), so this rehydrates them into the shapes the
// assertions already read — the tests keep asserting on `{kind, value, line, produces}`, not on a wire format.
//
// Deliberately NOT a general-purpose wrapper: only what the coupling tests actually call. A helper that grows
// past its callers becomes a second engine to keep in sync.
import { loadAddon } from "../../src/codebase/rust_core.js";

const core = () => {
  const a = loadAddon();
  if (!a) throw new Error("the Seam core (Rust addon) is not available — build it with `cargo build --release` in rust/");
  return a;
};

// `process.env` does NOT cross the napi boundary. A test that flips SEAM_NO_ADAPTERS / SEAM_ADAPTERS_DIR and
// then asks the core a question is otherwise measuring the UNSET default — the failure mode is a green test
// asserting the opposite of what it says. Sync the SEAM_* view, and drop the per-repo memo with it, since the
// floor it holds was derived under the old view.
const syncEnv = (repo?: string) => {
  const a = core();
  a.syncSeamEnv(Object.entries(process.env).filter(([k, v]) => k.startsWith("SEAM_") && v !== undefined) as [string, string][]);
  if (repo) a.resetCaches(repo);
};

export interface KeyHit { kind: string; value: string; line: number; produces: boolean; op?: string; label?: string; method?: string; recv?: string }
export interface Access { file: string; line: number }
export type GroundingIndex = Map<string, { producers: Access[]; consumers: Access[] }>;

// `[kind, value, line, produces, op, label, method, recv]` → a KeyHit with the EMPTY optionals dropped, so a
// `toEqual` against `{kind, value, line, produces}` still matches (napi sends "" where TS sent undefined).
export function scan_file_keys(file: string, text: string): KeyHit[] {
  return core().scanFileKeys(file, text).map(([kind, value, line, produces, op, label, method, recv]: string[]) => {
    const h: KeyHit = { kind, value, line: Number(line), produces: produces === "true" };
    if (op) h.op = op;
    if (label) h.label = label;
    if (method) h.method = method;
    if (recv) h.recv = recv;
    return h;
  });
}

const rowsToIndex = (rows: string[][]): GroundingIndex => {
  const idx: GroundingIndex = new Map();
  for (const [key, side, file, line] of rows) {
    if (!idx.has(key)) idx.set(key, { producers: [], consumers: [] });
    (side === "p" ? idx.get(key)!.producers : idx.get(key)!.consumers).push({ file, line: Number(line) });
  }
  return idx;
};

/// The merged floor (`shared ∪ param`), and the two parts separately — `shared` is what the adapters grounded,
/// `param` is what a resolved parameter CONSTANT did, and telling them apart is the point of several tests.
// The trailing `_ignored` is where callers used to pass the TS engine's SKIP_DIRS and EngineCtx. The core owns
// its own file walk and its own per-repo memo, so there is nothing to hand it — accepted and dropped rather
// than forcing a churn edit through every call site.
export const floor_base_index = (repo: string, ..._ignored: unknown[]): GroundingIndex => { syncEnv(repo); return rowsToIndex(core().floorIndex(repo)); };
export const shared_key_index = (repo: string, ..._ignored: unknown[]): GroundingIndex => { syncEnv(repo); return rowsToIndex(core().floorIndexPart(repo, "shared")); };
export const param_key_index = (repo: string, ..._ignored: unknown[]): GroundingIndex => { syncEnv(repo); return rowsToIndex(core().floorIndexPart(repo, "param")); };

// The complements of one key. Two forms, because the tests need both: over the REPO's own floor, and over a
// HAND-BUILT index — the route fanout-suppression rules are ranking decisions over a candidate set, and
// pinning them needs a controlled set rather than a repo that happens to produce one.
export const otherSide = (repo: string, kind: string, value: string, produces: boolean): Access[] =>
  core().otherSide(repo, kind, value, produces).map(([file, line]: string[]) => ({ file, line: Number(line) }));

export const otherSideOver = (index: GroundingIndex, kind: string, value: string, produces: boolean): Access[] => {
  const rows: string[][] = [];
  for (const [key, sides] of index) {
    for (const a of sides.producers) rows.push([key, "p", a.file, String(a.line)]);
    for (const a of sides.consumers) rows.push([key, "c", a.file, String(a.line)]);
  }
  return core().otherSideOver(rows, kind, value, produces).map(([file, line]: string[]) => ({ file, line: Number(line) }));
};

export const routeMatchSpecificity = (a: string, b: string): number => core().routeMatchSpecificity(a, b);
export const routeSuffixMatch = (a: string, b: string): boolean => core().routeSuffixMatch(a, b);
export const handlerShaped = (file: string): boolean => core().handlerShaped(file);

export interface OtherSide { kind: string; value: string; file: string; symbol: string; edgeKind: string; provenance: string }
export interface Truncation { kind: string; value: string; scanned: number; total: number; reason: string }
// The crossings AND the bounds that bit while finding them. `truncations` is a property on the returned array
// rather than a second return value, because every existing caller reads the sides positionally — and dropping
// it would let a bounded walk read as an exhaustive one, which is the one thing this call must not do.
export const couplingOtherSides = (repo: string, file: string, symbol: string, opts: { llm?: boolean } = {}, ..._ignored: unknown[]): OtherSide[] & { truncations: Truncation[] } => {
  syncEnv();
  const r = core().couplingOtherSides(repo, file, symbol, opts.llm ?? false, undefined, undefined);
  return Object.assign(r.sides as OtherSide[], { truncations: r.truncations as Truncation[] });
};

// `stableFloor` was read off the EngineCtx in TypeScript; in the core it is an explicit parameter, so it is
// passed rather than smuggled. The `opts` slot the TS signature had (dataCoupling/llm) is gone: the core's
// deterministic path IS `dataCoupling: true, llm: false`, and the LLM arm is the flywheel's, not this call's.
export interface CouplingNode { id: string; symbol: string; kind: string; file: string; start: number; end: number; enclosing: string; direction: string }
export interface Crossing { from: string; to: string; kind: string; line: number; op: string }
export const resolveCoupling = (repo: string, anchorId: string, file: string, text: string, lo: number, hi: number, counter = 0, stableFloor = false):
    { nodes: CouplingNode[]; edges: Crossing[]; blindspots: string[]; counter: number } => {
  const r = core().resolveCoupling(repo, anchorId, file, text, lo, hi, counter, stableFloor);
  // The addon pre-serializes each node/edge to a pipe row (the parity format). Every node it returns IS a
  // coupling node — there is no `coupling` flag to test, because the call only ever emits those.
  return {
    nodes: r.nodes.map((row: string) => {
      const [id, symbol, kind, f, start, end, enclosing, , direction] = row.split("|");
      return { id, symbol, kind, file: f, start: Number(start), end: Number(end), enclosing, direction };
    }),
    edges: r.edges.map((row: string) => {
      const [from, to, kind, line, op] = row.split("|");
      return { from, to, kind, line: Number(line), op };
    }),
    blindspots: r.blindspots,
    counter: r.counter,
  };
};

// The LEARN half of the flywheel: validate LLM-shaped matcher objects, then persist them into `<repo>/.seam`
// so the next resolve REPLAYS them. Staging a learned rule this way is how a test distinguishes "the floor
// grounded it" from "a learned matcher did" — the whole point of the stable-floor contract.
export const persistMatchers = (repo: string, matchers: unknown[]): void => core().persistMatchers(repo, JSON.stringify(matchers));

// EFFECT INFERENCE — which receivers are custom http clients, the matchers that key their call sites, and the
// indirected-route resolution on a proven edge. All three are the core's; these keep the shapes the
// integration tests read.
export const inferHttpClients = (files: { rel: string; text: string }[]): Set<string> =>
  new Set(core().inferHttpClientsOver(files.map((f) => [f.rel, f.text])) as string[]);

export const inferHttpClientMatchers = (files: { rel: string; text: string }[]): any[] =>
  JSON.parse(core().inferHttpClientMatchers(files.map((f) => [f.rel, f.text])));

export const runMatcher = (matcher: unknown, file: string, text: string): KeyHit[] =>
  (core().runMatcherJson(JSON.stringify(matcher), file, text) as string[]).map((row) => {
    const [kind, value, line, produces, op] = row.split("|");
    const h: KeyHit = { kind, value, line: Number(line), produces: produces === "true" };
    if (op) h.op = op;
    return h;
  });

export const resolveHttpCallSites = (file: string, text: string, clients: Iterable<string>): KeyHit[] =>
  (core().resolveHttpCallSites(file, text, [...clients]) as string[]).map((row) => {
    const [kind, value, line, produces] = row.split("|");
    return { kind, value, line: Number(line), produces: produces === "true" };
  });

// STRUCTURAL pre-clustering — re-exported from where the product reads it, so a test and the flywheel can
// never be clustering by different rules.
export { clusterBlindFiles, type BlindCluster } from "../../src/codebase/coupling/core_floor.js";

// ── THE MATCHER IR ───────────────────────────────────────────────────────────────────────────────────────
// Validating an LLM-proposed rule, executing one, and the two guards that bound what a rule may key on.
// `validateMatcher` returns null for a proposal that is not a well-formed rule — the model is allowed to be
// wrong, and a malformed shape must be dropped rather than half-applied.
// A validated rule, shaped loosely on purpose: the variants differ by `via`, and the tests read whichever
// fields their shape has. Pinning a discriminated union here would just re-declare the Rust enum in
// TypeScript — the second definition this migration exists to remove.
export interface KeyMatcher { via: string; kind: string; role: string; [k: string]: unknown }
export const validateMatcher = (obj: unknown): KeyMatcher | null => JSON.parse(core().validateMatchers(JSON.stringify([obj])))[0];
// NULL, not "", when the shape has no literal (a `method` rule matches structurally). The napi boundary
// cannot carry a null String, so the translation happens here — and it is not cosmetic: absent means "no
// pre-filter is possible, always run the regex", while an empty string would read as "match files containing
// nothing", which every file does.
export const matcherLiteral = (m: unknown): string | null => core().matcherLiteral(JSON.stringify(m)) || null;
export const plausibleKeyValue = (v: string): boolean => core().plausibleKeyValue(v);
export const isTerminalKind = (kind: string): boolean => core().isTerminalKind(kind);

/// Ground a CALLER-SUPPLIED rule set over the repo — `applyMatchers`. The repo-store form is what the product
/// runs; this one is for a test that wants to know its own rule grounded, not that some other learned rule did.
export const applyMatchers = (repo: string, matchers: unknown[]): GroundingIndex => {
  const idx: GroundingIndex = new Map();
  for (const row of core().applyMatchersOver(repo, JSON.stringify(matchers)) as string[]) {
    const [key, side, file, line] = row.split("|");
    if (!idx.has(key)) idx.set(key, { producers: [], consumers: [] });
    (side === "p" ? idx.get(key)!.producers : idx.get(key)!.consumers).push({ file, line: Number(line) });
  }
  return idx;
};

// ── THE ADAPTER REGISTRY ─────────────────────────────────────────────────────────────────────────────────
// One adapter's keys in a file (`adapterKeys`), the boundary semantics of a kind, the scannable-file gate,
// and the two mask primitives every adapter shares. The registry itself is the core's.
export const adapterKeys = (name: string, file: string, text: string): KeyHit[] =>
  (core().adapterKeys(name, file, text) as string[][]).map(([kind, value, line, produces, op, label, method, recv]) => {
    const h: KeyHit = { kind, value, line: Number(line), produces: produces === "true" };
    if (op) h.op = op;
    if (label) h.label = label;
    if (method) h.method = method;
    if (recv) h.recv = recv;
    return h;
  });

export interface KindSemantics { nodeKind: string; produceEdge: string; consumeEdge: string; handlerEdge?: string; terminal?: boolean }
export const kindOf = (kind: string): KindSemantics => {
  const [nodeKind, produceEdge, consumeEdge, handlerEdge, terminal] = core().kindOf(kind) as string[];
  const k: KindSemantics = { nodeKind, produceEdge, consumeEdge };
  if (handlerEdge) k.handlerEdge = handlerEdge;
  if (terminal === "true") k.terminal = true;
  return k;
};

export const scannableForKeys = (file: string): boolean => core().scannableForKeys(file);
export const couplingCapabilities = () => (core().couplingCapabilities() as string[][])
  .map(([kind, nodeKind, tier, ...detectedBy]) => ({ kind, nodeKind, tier: tier as "built-in" | "learned", detectedBy }));
export const maskComments = (text: string): string => core().maskComments(text);
export const stringLiteralsOnly = (text: string): string => core().stringLiteralsOnly(text);

// ── COMMUNITY FRAMEWORK PLUGINS ──────────────────────────────────────────────────────────────────────────
// Registering a framework the built-in adapters do not know — a project's own route annotation, its ORM's
// verbs, its http client. The registration lives in the CORE because that is what scans; a test that
// registered only with a TypeScript registry would assert against a scanner that never heard about it.
export const registerRouteAnnotation = (name: string, method?: string): void => core().registerRouteAnnotation(name, method);
export const registerOrmMethod = (method: string, write: boolean): void => core().registerOrmMethod(method, write);
export const registerHttpClients = (names: string[]): void => core().registerHttpClients(names);
export const resetFrameworkPlugins = (): void => core().resetFrameworkPlugins();
