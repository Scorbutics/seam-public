// COUPLING ARCHETYPES — the closed, structural vocabulary of HOW two sides of a shared-key coupling wire up
// and grow: kind → boundary node label + produce/consume edge labels (+ handlerEdge for routes). This is the
// "B" half of an adapter (the SEMANTICS), deliberately SEPARATED from detection (the "A" half, scan logic).
//
// Why separate: detection of framework UI couplings is LEARNED (key_ir.ts shapes, flywheel-synthesized) and
// per-repo; the SEMANTICS are a small fixed set every learned rule reuses. A learned `event` matcher must
// still ground on an "event" boundary with event-emit/event-on edges — even though no built-in adapter
// detects events anymore (event_binding was deleted). So the metas live HERE, sourced once, and `kindOf`
// consults this registry for any kind a present detection adapter doesn't already own.
//
// CLAUDE.md: structural → from the source-of-truth, not a hardcoded duplicate. This IS the source of truth
// for kind semantics; the built-in detection adapters (db_table/http_route/…) reuse these same metas.
import type { KeyKind } from "../types.js";
import { DB_TABLE_META } from "./db_table.js";
import { HTTP_ROUTE_META } from "./http_route.js";

export type Archetype = Omit<KeyKind, "scan" | "name" | "blurb" | "extraExts">;

export const ARCHETYPES: Record<string, Archetype> = {
  "db-table": DB_TABLE_META,                                                                              // persistent domain entity
  "http-route": HTTP_ROUTE_META,                                                                          // client fetch ⇄ server handler (handlerEdge → grow downstream)
  "data-file": { kind: "data-file", nodeKind: "data-file", produceEdge: "file-write", consumeEdge: "file-read" },
  // DISPATCH archetypes (event/queue): the producer fires and forgets; the CONSUMER side (listener/subscriber)
  // IS the downstream handler — structurally the same as a route's server side — so `handlerEdge` = consumeEdge.
  // Crossing an emit/publish INTO its listener/subscriber then expands DOWNSTREAM (like a route→handler→bean),
  // not upstream toward "who else emits". (http-route's handler is its PRODUCER side, hence produceEdge there.)
  event:   { kind: "event",   nodeKind: "event",   produceEdge: "event-emit",     consumeEdge: "event-on",        handlerEdge: "event-on" },        // emit ⇄ listener (was event_binding)
  binding: { kind: "binding", nodeKind: "binding", produceEdge: "binding-define", consumeEdge: "binding-call" },    // component method ⇄ template call (was ng_scope) — symmetric UI wiring, no downstream handler
  queue:   { kind: "queue",   nodeKind: "queue",   produceEdge: "queue-publish",  consumeEdge: "queue-subscribe", handlerEdge: "queue-subscribe" }, // publish ⇄ subscriber (the handler)
  cache:   { kind: "cache",   nodeKind: "cache",   produceEdge: "cache-write",    consumeEdge: "cache-read" },      // shared cache key
};

// Every archetype meta (for deriving the engine-wide edge/node-kind sets), deduped by kind.
export const ARCHETYPE_METAS: Archetype[] = Object.values(ARCHETYPES);
