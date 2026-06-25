// The framework-adapter REGISTRY — a LIST, because several adapters can emit the SAME key kind
// (Supabase builder + raw SQL both → `db-table`, coupling a builder reader to a JDBC writer of one
// table). Register an adapter here and both the deterministic floor (scan_file_keys) and the LLM
// front-end (discover_keys → grounding) cover it. A generic fallback kind handles LLM-proposed keys
// with no registered adapter (queue/event/route/cache/…).
import { endsWithSourceExt } from "../../../core/resolve/languages/index.js";
import { plausibleKeyValue } from "../key_ir.js";
import { COUPLING } from "../config.js";
import { makeMaskCtx } from "./util.js";
import type { MaskCtx } from "../types.js";
import type { KeyHit, KeyKind } from "../types.js";
import { SUPABASE, DB_TABLE_META } from "./db_table.js";
import { RAW_SQL } from "./raw_sql.js";
import { ACTIVE_RECORD } from "./active_record.js";
import { JOOQ } from "./jooq.js";
import { HTTP_ROUTE } from "./http_route.js";
import { ANNOTATION_ROUTE_ADAPTER } from "./annotation_route.js";
import { FILE_CHANNEL } from "./file_channel.js";
import { VUE_INJECT } from "./vue_inject.js";
import { ARCHETYPES, ARCHETYPE_METAS } from "./archetypes.js";

// FRAMEWORK UI couplings (AngularJS $scope bindings, Vue/Angular EVENTS, component-method↔template) are NOT
// built-in — too framework-specific and varied — they are LEARNED via the flywheel's closed IR shapes
// (key_ir.ts: call/assign/method/attr) and cached to `.seam/`. ng_scope + event_binding were ported there.
// The EXCEPTION is service INJECTION (Vue.prototype.$x / globalProperties.$x ⇄ this.$x): a single closed,
// `$`-discriminated shape stable across Vue 2/3, common enough that the LLM flywheel being off by default
// (cold-grow stability) AND the local coupling gate skipping a `this.$x` anchor left it undetected. It's
// deterministic floor (VUE_INJECT) so it works without the flywheel and the gate sees the boundary.
export const ADAPTERS: KeyKind[] = [SUPABASE, RAW_SQL, ACTIVE_RECORD, JOOQ, HTTP_ROUTE, ANNOTATION_ROUTE_ADAPTER, FILE_CHANNEL, VUE_INJECT];

// MARKUP/TEMPLATE file extensions that carry framework couplings (Vue SFC, HTML/AngularJS/Angular
// templates). STRUCTURAL: which file types can hold a shared key is a fact about the file type, independent
// of the (now learned) DETECTION logic — so the coupling walk scans them for the learned `attr` matchers
// even though the rest of the pipeline doesn't treat them as source. This is the source of truth; a learned
// rule never needs to re-declare it.
export const TEMPLATE_EXTS = [".vue", ".html", ".htm"];

// The BUILT-IN adapter catalogue (name + one-line blurb), derived FROM the registry — the single source,
// so adding an adapter to ADAPTERS automatically surfaces it in `seam-adapters` / the extension's adapter
// view (no parallel list to keep in sync). These are the deterministic, always-present, code-level adapters
// (status "built-in"), as opposed to the LLM-LEARNED ones in `.seam/` (status learnt/promoted).
export function builtinAdapters(): { name: string; kind: string; description: string }[] {
  return ADAPTERS.map((a) => ({ name: a.name ?? a.kind, kind: a.kind, description: a.blurb ?? "" }));
}

// The coupling CAPABILITY CATALOGUE — every boundary archetype + HOW it is detected, derived structurally
// from the registry (ADAPTERS ∩ ARCHETYPES), never hardcoded. An archetype whose kind a built-in adapter
// owns is `built-in` (Tier-1: deterministic, offline, always-on — db-table/http-route/data-file). One with
// NO detection adapter (event/binding/cache/queue) is `learned` (Tier-2): the kind SEMANTICS exist, but
// detection is synthesised by the flywheel and warms on first LLM-enabled review, then caches to `.seam/`.
// Surfaced by `seam-adapters` so this conditional coverage is HONEST instead of invisible to a user.
export function couplingCapabilities(): { kind: string; nodeKind: string; tier: "built-in" | "learned"; detectedBy: string[] }[] {
  return ARCHETYPE_METAS.map((arch) => {
    const detectors = ADAPTERS.filter((a) => a.kind === arch.kind);
    return { kind: arch.kind, nodeKind: arch.nodeKind, tier: detectors.length ? "built-in" : "learned", detectedBy: detectors.map((a) => a.name ?? a.kind) };
  });
}

const GENERIC: KeyKind = { kind: "key", nodeKind: "resource", produceEdge: "key-write", consumeEdge: "key-read", scan: () => [] };
// Kind metadata (node label + edge kinds) for a key kind: a PRESENT detection adapter owns its kind; else
// the ARCHETYPE registry supplies the semantics (so a learned `event`/`binding`/… matcher grounds with the
// right boundary + edges even though no built-in adapter detects it); else GENERIC.
export const kindOf = (kind: string): KeyKind => {
  const adapter = ADAPTERS.find((a) => a.kind === kind);
  if (adapter) return adapter;
  const arch = ARCHETYPES[kind];
  return arch ? { ...arch, scan: () => [] } : GENERIC;
};

// Engine-wide edge/node-kind sets are derived from BOTH the present detection adapters AND the archetype
// registry (+ GENERIC) — so a learned-only kind's edges/nodes still count as key crossings / flow subjects.
const _ALL_METAS = [...ADAPTERS, ...ARCHETYPE_METAS, GENERIC];
// Edge kinds the rung emits — codebase._is_crossing unions these so each becomes a grow-frontier crossing.
export const KEY_EDGE_KINDS = new Set(_ALL_METAS.flatMap((k) => [k.produceEdge, k.consumeEdge]));
// Boundary NODE kinds the rung emits (table/route/event/binding/resource/…). A footprint that contains one
// has a data SUBJECT → it's a FLOW (a pipeline), not a cross-cutting POLICY — see codebase._detect_shape.
export const KEY_NODE_KINDS = new Set(_ALL_METAS.map((k) => k.nodeKind));
// PERSISTENT domain-entity subjects (db tables: payments, members, …) — the registry's db-table family,
// as opposed to TRANSPORT (routes) or generic resources. Subject-continuity keys on the domain ENTITY, so
// a payment seam touching its own `/api/payments` route isn't mistaken for a fork into another domain.
export const DOMAIN_SUBJECT_KINDS = new Set(ADAPTERS.filter((a) => a.kind === DB_TABLE_META.kind).map((a) => a.nodeKind));
// The WRITE (produce) edge kinds — a node that is the SRC of one of these PRODUCES the key/subject (a db
// write, a created record, a dispatched message), as opposed to merely reading it. Sourced from the
// registry (each adapter declares its `produceEdge`) so a new adapter's write kind auto-counts. The
// intent pass uses this to ground the culmination: a flow CULMINATES where it writes its subject.
export const KEY_PRODUCE_EDGE_KINDS = new Set([...ADAPTERS, GENERIC].map((k) => k.produceEdge));

// Every adapter's key accesses in one file (the deterministic floor scan). SEAM_NO_ADAPTERS=1 disables
// the framework floor entirely — the FRAMEWORK-AGNOSTIC test: with the hand-written adapters unlinked,
// every node is floor-blind, so the fallback-gated LLM key pass (maybe_discover_keys) fires everywhere
// and must REGENERATE the couplings the adapters had hard-coded. Carrier-channel (data-file) is separate.
export function scan_file_keys(file: string, text: string, masked?: MaskCtx): KeyHit[] {
  if (process.env.SEAM_NO_ADAPTERS === "1") return [];
  if (COUPLING.maxScanBytes && text.length > COUPLING.maxScanBytes) return [];   // skip minified/generated bundles — char-scanning them dominates index time, holds no intent key
  const m = masked ?? makeMaskCtx(text);   // mask ONCE per file, shared across all adapters (was 4× maskComments + 1× stringLiteralsOnly)

  // Universal floor guard: drop implausible key values (generic words like "the", prose, too-short) from
  // ANY adapter — the deterministic floor isn't immune (raw-SQL matched the English "…select … from the …"
  // as a db-table read across 32 files). plausibleKeyValue is the same identifier-shape filter the LLM/
  // matcher paths use, applied here so a coincidental match can't become a shared-key boundary.
  return ADAPTERS.flatMap((a) => a.scan(file, text, m)).filter((h) => plausibleKeyValue(h.value));
}

// Non-source file extensions the coupling walk ALSO scans for shared keys: the structural TEMPLATE_EXTS
// (markup that carries framework bindings — for the learned `attr` matchers) UNION any adapter's own
// `extraExts`. SEAM_NO_ADAPTERS disables the floor → no extra exts either.
const EXTRA_EXTS = [...new Set([...TEMPLATE_EXTS, ...ADAPTERS.flatMap((a) => a.extraExts ?? [])])].map((e) => e.toLowerCase());

// The "is this file worth scanning for shared keys" predicate — SOURCE_EXTS (the global source set) PLUS
// the adapters' template extras. The coupling walks (shared_key_index, llmKeyIndex) use THIS instead of
// endsWithSourceExt so a listener in a `.vue`/`.html` template grounds against an emitter in a `.js`,
// without making the rest of the pipeline (parsing/resolution) treat templates as source.
export function scannableForKeys(file: string): boolean {
  if (endsWithSourceExt(file)) return true;
  if (process.env.SEAM_NO_ADAPTERS === "1") return false;
  const f = file.toLowerCase();
  return EXTRA_EXTS.some((e) => f.endsWith(e));
}
