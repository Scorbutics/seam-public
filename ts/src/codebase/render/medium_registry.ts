// SHARED-KEY MEDIA registry — the closed set of coupling archetypes every render view (region/wave/scenario/
// agent/concern) names crossings by. A crossing over any of these is a link between two layers via a shared
// KEY (a route path / table / topic), not a direct call. `pull` = the CONSUMER initiates the flow (an HTTP
// client fetch); otherwise the PRODUCER does (a writer / publisher / emitter pushing to the boundary). Drives
// boundary detection, the wave link verb, and the scenario orientation. One registry instead of the several
// near-identical kind-set copies llm_context.ts used to carry per render function.
import { loadAddon } from "../rust_core.js";
export const MEDIA: { medium: string; produce: string; consume: string; pull?: boolean; wave: string }[] = [
  { medium: "HTTP route", produce: "route-serve", consume: "route-fetch", pull: true, wave: "via HTTP route from" },
  { medium: "table", produce: "db-write", consume: "db-read", wave: "sharing a DB table with" },
  { medium: "queue", produce: "queue-publish", consume: "queue-subscribe", wave: "over a queue with" },
  { medium: "event", produce: "event-emit", consume: "event-on", wave: "via an event with" },
  { medium: "cache", produce: "cache-write", consume: "cache-read", wave: "sharing a cache with" },
  { medium: "file", produce: "file-write", consume: "file-read", wave: "sharing a file with" },
  { medium: "service", produce: "service-write", consume: "service-read", wave: "sharing service state with" },   // stateful external SDK handle (auth/session/…): mutate ⇄ read the same singleton
  { medium: "egress", produce: "egress-call", consume: "egress-return", wave: "calls out to" },   // outbound call to an EXTERNAL system (HTTP host/broker) — terminal, produce-only (no in-repo consumer)
];

// edge-kind → medium; and the SOURCE edges (point code→boundary: the consumer's fetch for a pull medium, the
// producer's write/publish otherwise) vs SINK edges (boundary→code: deliver to the receiver).
export const MEDIUM_OF = new Map<string, { medium: string; wave: string }>();
export const CROSS_SOURCE = new Set<string>(), CROSS_SINK = new Set<string>(), CROSS_KINDS = new Set<string>();
for (const m of MEDIA) {
  MEDIUM_OF.set(m.produce, m); MEDIUM_OF.set(m.consume, m);
  const src = m.pull ? m.consume : m.produce, sink = m.pull ? m.produce : m.consume;
  CROSS_SOURCE.add(src); CROSS_SINK.add(sink); CROSS_KINDS.add(m.produce); CROSS_KINDS.add(m.consume);
}
export const WAVE_VERB: Record<string, string> = {
  call: "called by", import: "used by", reference: "referenced by", "interface-impl": "implemented by",
  contains: "declared in", "type-ref": "typed by", "data-coupling": "sharing a key with",
};
for (const [kind, m] of MEDIUM_OF) WAVE_VERB[kind] = m.wave;   // every shared-key crossing names its medium
export const WAVE_RANK = (k: string): number =>
  (k === "call" ? 0 : CROSS_KINDS.has(k) ? 1 : k === "import" || k === "reference" || k === "interface-impl" ? 2 : k === "contains" ? 4 : 3);

// BOUNDARY kinds, READ FROM THE CORE's archetype registry — the node kinds a crossing can be grounded as.
//
// This list used to be a hardcoded literal here, and it had gone STALE against the engine that emits the
// kinds. The core renamed `file` → `data-file` and grounds any medium with no adapter as `resource`
// (GENERIC), and neither name ever reached this copy — so `emit._seam_hunk` (which carries `kind` for
// BOUNDARY nodes only) silently dropped it for every file-channel and generic boundary, and the render had
// no medium to name or ground. Measured: a `data-file`/`resource` hunk emitted with `kind: undefined` while
// `table`/`route`/`service`/`egress` kept theirs.
//
// The LEGACY aliases below are kept deliberately. They are names the core no longer emits (`db-table`,
// `http-route`, `file`, `key`, `topic`), but a model JSON persisted by an older engine — a cached `.seam`
// footprint, a checked-in fixture — still carries them, and a reader that stopped recognising them would
// silently reclassify an old boundary as code. Additive, so they cost nothing.
const _LEGACY_MEDIA = ["db-table", "http-route", "file", "key", "topic"];
const _coreBoundary = (): string[] => {
  try { return (loadAddon()?.boundaryNodeKinds() ?? []) as string[]; } catch { return []; }
};
// RELAYS pass a message through to a handler; everything else is a STORE you write into and read back. The
// split is kept as an explicit relay list rather than derived from `handler_edge`, because queue and event
// DO have handler edges and are nonetheless treated as stores here — deriving it structurally would silently
// reclassify them.
const _RELAY_KINDS = new Set(["route", "http-route", "annotation"]);
export const BOUND_KINDS: Set<string> = new Set([..._coreBoundary(), ..._LEGACY_MEDIA, "annotation"]);
export const STORE_KINDS: Set<string> = new Set([...BOUND_KINDS].filter((k) => !_RELAY_KINDS.has(k)));
