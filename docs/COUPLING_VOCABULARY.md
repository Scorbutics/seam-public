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
| **node** | A vertex in the seam graph. Coupling emits **boundary nodes**: a synthetic node standing for the key itself (the table / route), placed *between* the producer and the consumer. |
| **edge** | A link between two nodes. A coupling edge is a **crossing** (`db-write` / `db-read`, `route-serve` / `route-call`): the produce/consume link from a real file to a boundary node. |
| **complement / other side** | Given the anchor *produces* key X, its complements are the files that *consume* X (and vice-versa). `otherSide()` returns them from the index. |
| **anchor** | The symbol/file span the analysis starts from — the thing whose data couplings we're resolving. |
| **carrier** | Ruby's homemade data-file wrapper (the `.rxdata` channel). A second *deterministic* source of keys, fed in alongside the per-file scan. |

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
