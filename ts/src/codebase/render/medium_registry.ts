// SHARED-KEY MEDIA registry — the closed set of coupling archetypes every render view (region/wave/scenario/
// agent/concern) names crossings by. A crossing over any of these is a link between two layers via a shared
// KEY (a route path / table / topic), not a direct call. `pull` = the CONSUMER initiates the flow (an HTTP
// client fetch); otherwise the PRODUCER does (a writer / publisher / emitter pushing to the boundary). Drives
// boundary detection, the wave link verb, and the scenario orientation. One registry instead of the several
// near-identical kind-set copies llm_context.ts used to carry per render function.
export const MEDIA: { medium: string; produce: string; consume: string; pull?: boolean; wave: string }[] = [
  { medium: "HTTP route", produce: "route-serve", consume: "route-fetch", pull: true, wave: "via HTTP route from" },
  { medium: "table", produce: "db-write", consume: "db-read", wave: "sharing a DB table with" },
  { medium: "queue", produce: "queue-publish", consume: "queue-subscribe", wave: "over a queue with" },
  { medium: "event", produce: "event-emit", consume: "event-on", wave: "via an event with" },
  { medium: "cache", produce: "cache-write", consume: "cache-read", wave: "sharing a cache with" },
  { medium: "file", produce: "file-write", consume: "file-read", wave: "sharing a file with" },
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

// STORE kinds — the persistent-boundary subset of media (a table/queue/event/cache/topic/file/key/binding, as
// opposed to a route which is a RELAY, not a store). BOUND kinds = STORE plus the relay/annotation boundaries.
export const STORE_KINDS = new Set(["db-table", "table", "queue", "event", "cache", "topic", "file", "key", "binding"]);
export const BOUND_KINDS = new Set([...(STORE_KINDS as Set<string>), "route", "http-route", "annotation"]);
