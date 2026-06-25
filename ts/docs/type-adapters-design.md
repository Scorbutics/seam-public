# Type-Adapters + Receiver Classification

## The problem this replaces

The flywheel learns a **rule per receiver/shape** (`member:prisma`, `call:getItem`, …). On a real
project that accumulates into ~150 near-identical adapters — **adapter bloat** — most of which say the same
thing ("this receiver is a database / an HTTP client / a store") in slightly different words.

`member_access` already proved the alternative in miniature: **one** framework-agnostic *database-type*
adapter (any receiver, the ORM verb idiom) replaced what would have been N per-receiver `member:*` rules.
This design generalises that: a **small fixed set of TYPE adapters**, and every receiver is **classified
into a type** rather than getting its own persisted rule.

## The model

```
~6 TYPE adapters (durable)          classify each recurring receiver, cheapest-first:
  database · http · config            1. distinctive verb IDIOM   → deterministic (ORM verbs ⇒ database)
  store · event · (none)              2. EMBEDDING vs type anchors → trust if max score ≥ τ (~0.4)
                                      3. LLM                       → only when score < τ (genuine doubt)
type drives: extraction · roles ·   cached per RECEIVER (a thin receiver→type map, NOT a rule per receiver)
grounding · IMPORTANCE
```

**Mimic the dev's head:** the cheap deterministic layer *extracts recurring receiver-access patterns* (the
inventory: receiver + verb profile + sites); the semantic layer *judges what each one is*. A dev doesn't
match a known client name — they recognise the role of a recurring thing from how it's used.

### The TYPE set (closed, small)

| type | key is… | role mapping | importance |
|---|---|---|---|
| `database` | the entity/table (3-part: the member; 2-part repo: the receiver) | read verbs → consume, write → produce | data boundary |
| `http` | the route literal | caller → consume, handler → produce | **hard edge** (stack-crossing) |
| `config` | the config-key string | get → consume, set → produce | ambient |
| `store` | the state/cache-key string | get → consume, set/dispatch → produce | ambient |
| `event` | the event/topic string | emit/publish → produce, on/subscribe → consume | boundary |
| `none` | — | — | **dropped** (logging, test, stdlib, local collections) |

### The 3-rung classification ladder

1. **Idiom (deterministic).** A distinctive verb idiom decides the type with no model — the ORM verb set
   (`findUnique`/`upsert`/`deleteMany`…) ⇒ `database`. This is `member_access` today.
2. **Embedding (cheap semantic).** Embed the receiver's verb profile, score against per-type anchors
   (incl. **noise anchors** so logging/test/stdlib classify *into* `none`). Trust the argmax when its score
   ≥ τ. Validated on cal.com: everything ≥ 0.4 was correct; the score *is* the confidence signal.
3. **LLM (doubt only).** When the top embedding score < τ — the genuinely ambiguous / polysemous receivers
   (`users` = repo or array, `service` = domain) — ask the LLM. Cached.

Grounding (co-occurrence of the literal key) is **unchanged** and is the misclassification backstop: a
mis-typed key that doesn't co-occur on both sides simply never grounds.

## What it changes vs today

- **Per-receiver flywheel rules → type-adapters + a receiver→type cache.** No bloat.
- **The LLM's job shifts** from "scan this file for keys" / "synthesise a rule per shape" to "classify this
  receiver" — one judgment per recurring receiver, only on doubt, cached.
- **Importance becomes first-class:** `http` receivers are hard edges surfaced even when the route value is
  composed/unresolved (the globex blindspot); `none` receivers are dropped (noise filtered at the receiver
  level, once).

## Phasing (each phase ships as default, validated on cal.com + suite green)

- **Phase 1 — classifier core + 2-part `repository` data-access.** The classifier (idiom + embedding rungs,
  cached) plus a `repository` matcher shape it synthesises deterministically for `database`-classified 2-part
  receivers (`users.create()`, `featuresRepository.set…()`) — the couplings `member_access` (3-part) misses.
  Additive; the flywheel stays intact. **This commit.**
- **Phase 2 — config/store/event extraction** from classified receivers; demote the matching flywheel shapes.
- **Phase 3 — http receiver-level hard edges** + importance into the intent ranking / fan cap.
- **Phase 4 — retire the per-receiver flywheel rules;** the LLM remains only as the classification doubt-rung.

## Caveats (carried, not hidden)

- **Polysemous names** (`users`, `service`) classify per-receiver-NAME with low confidence → the LLM rung;
  per-site refinement is deferred.
- **Noise sub-types blur** among themselves (`Promise` → test vs util) — harmless, all `none` drop.
- The inventory is a **repo-wide pre-pass** (cached per run); cost is the receiver walk, not per-grounding.
