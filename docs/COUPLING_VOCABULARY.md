# Shared-key coupling — vocabulary

The data-coupling engine (`ts/src/codebase/coupling/`) connects files that talk to each
other *without* an import or a function call — a writer and a reader that only share the
name of a database table, a queue topic, an event, or an HTTP route. Embeddings and
call-graphs can't see this link; the string they share is the only evidence.

This doc defines the words the code uses. With these eight terms in your head, the engine
reads roughly as it's meant to.

## The core terms

| Term | Meaning |
|------|---------|
| **key** | An identifier two files share with no import/call edge between them: a DB table name, a queue/topic, an event name, an HTTP route. The key *is* the coupling. |
| **shared-key** | The same thing — "shared" stresses that the coupling exists *because* both sides name the same string. |
| **produce / consume** | The write side vs the read side of a key. A file that writes `payments` **produces** it; a file that reads `payments` **consumes** it. An HTTP handler produces a route; a `fetch()` consumes it. |
| **node** | A vertex in the seam graph. Coupling emits **boundary nodes**: a synthetic node standing for the key itself (the table / route), placed *between* the producer and the consumer. Its **label** is the key value by default, but when the adapter supplies a human name it wins — a declarative endpoint-map entry `{ "updateBooking": { endpoint, method } }` labels its boundary `updateBooking` (the operation), not the raw route `/booking/v1/*`, so a footprint shows the symbol, not an opaque path. |
| **edge** | A link between two nodes. A coupling edge is a **crossing** (`db-write` / `db-read`, `route-serve` / `route-fetch`): the produce/consume link from a real file to a boundary node. |
| **complement / other side** | Given the anchor *produces* key X, its complements are the files that *consume* X (and vice-versa). `otherSide()` returns them from the index. |
| **anchor** | The symbol/file span the analysis starts from — the thing whose data couplings we're resolving. |
| **carrier** | A project-internal wrapper method that mediates access to a data channel (a file, a queue, a socket), where the key — a literal path or glob pattern — is passed as an argument. The engine traces whether the wrapper reads or writes (teacher 1), recovers the key from the call's string arg (teacher 2), and uses the LLM for opaque wrappers (teacher 3). A second *deterministic* source of keys, fed in alongside the per-file scan. Ruby is the first language with a carrier provider; the engine is provider-agnostic. |

## Carrier vs boundary — they live on different layers

Easy to conflate, because both sound like "the thing in the middle." They're not — a
**carrier is an INPUT, a boundary is an OUTPUT**, and the carrier sits *upstream* of the
boundary:

- A **carrier** is one of the *key sources* — how the engine *discovers* a key. It's a
  project-internal wrapper method (`save_data(x, 'Save.rxdata')`) that carries the key in as
  an argument. It is not a graph element. It sits alongside the other key sources: the
  per-file **scan** (floor) and the tier-3 LLM **proposals**.
- A **boundary node** is a *graph vertex* — the key drawn as a synthetic node between the
  producer and the consumer. An **edge/crossing** is a real file's produce/consume link *to*
  that node.

So the flow is one-directional: **carrier → key → boundary node + crossings**. Once a carrier
has yielded its `data-file <path>` key, it's done; from there the key is treated identically
to one found by the scan floor or proposed by the LLM (same grounding index, same boundary
node, same crossings). Worked example (Ruby):

| Step | Term | Value |
|------|------|-------|
| 1. discover the key | **carrier** | `save_data` / `load_data` wrappers (traced write/read, key from the literal arg) |
| 2. the key | **key** | `data-file Save.rxdata` |
| 3. sides | **produce / consume** | the `save_data` file produces it, the `load_data` file consumes it |
| 4. draw | **boundary node** | synthetic node for `data-file Save.rxdata`, between the two |
| 5. wire | **edge / crossing** | producer → boundary (`db-write`), boundary → consumer (`db-read`) |

## Supporting terms

| Term | Meaning |
|------|---------|
| **fan / fanout** | When one key has many complements (e.g. a hub table read in 40 files). `READER_CAP` limits how many complement nodes we materialise; the rest become a `shared-key-fanout` blindspot. |
| **chain / transitive** | A complement may itself sit on the *next* boundary — a `payments` reader that is the route handler the UI fetches. The engine recurses one hop into each complement, scanning *its* keys. `seenKeys` stops the chain looping back through the key it came in on. |
| **floor** | The deterministic key sources (per-file scan + carrier), as opposed to LLM-**proposed** keys. Floor keys are `fromScan: true`. |
| **proposed key** | A key the tier-3 LLM hypothesises (cross-framework). Kept only if the deterministic floor didn't already find it. If the repo-wide index can't ground it, it becomes a SUGGESTED blindspot rather than a node. |
| **grounding index** | `shared_key_index`: the repo-wide map `key → { producers, consumers }`. This is what turns "the anchor produces `payments`" into "...and these three files consume it." |
| **blindspot** | A coupling the engine sees evidence of but won't assert as a hard edge: an ungrounded LLM proposal, or the over-cap tail of a fanout. Surfaced for human review, not drawn as a resolved crossing. |

## How a single anchor resolves (the shape of `attach`)

1. **Collect the anchor's keys** from three sources — scan, carrier, LLM proposals — deduped.
2. **Build the grounding index** (repo-wide producers/consumers per key).
3. **Rank complements by co-occurrence** — a file on the other side of *several* of the
   anchor's keys is on-intent; one sharing only a single hub key is noise.
4. **For each key**: emit a boundary node + the anchor→boundary crossing, then attach up to
   `READER_CAP` ranked complements (each its own node + crossing).
5. **Chain** one hop into each complement, so a writer reaches the UI that reads it.

See `ts/src/codebase/coupling/index.ts` and `types.ts` for the implementation.
