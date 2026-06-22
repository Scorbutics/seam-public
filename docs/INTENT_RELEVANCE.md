# Intent relevance — deterministic embeddings

Seam's codebase grow returns the **full structural closure** of an anchor: every resolved import/call/
coupling edge, followed to its terminals. That breadth is correct — the tool's job is to *show everything
and highlight*, not to judge-by-hiding. But a broad closure (a REST entry transitively pulls in schema,
projection, DocuSign, …) is noisy when it feeds an LLM. So Seam attaches a **deterministic intent-relevance
ranking** to each seam — separating the intent *spine* from off-intent infrastructure **without cropping by
default**, and without an LLM call.

Relevance is a *semantic* judgement, but a **deterministic** one: per CLAUDE.md, semantic work belongs to
"the LLM **or embeddings**." Embeddings are reproducible (same model + same input → same vector → same
ranking), offline, and cached — so they give intent-awareness while keeping the engine deterministic.

## The model

`Xenova/all-MiniLM-L6-v2` via `@xenova/transformers` (feature-extraction, **mean-pooled**, **L2-
normalized**); similarity is plain **cosine**. Lazily loaded (the ~23 MB model + the lib are externalized in
the bundled `.vsix`, so every caller degrades to its non-embed path when they're absent). Per-def vectors
are disk-cached under `~/.cache/seam/embed/<hash(repo|model)>.json`, keyed by the embed-string hash and
**incremental** (only new/changed defs are embedded). Code lives in `src/codebase/scan/def_embed.ts`.

## What gets compared: the **passage** vs the **query**

Relevance is `cosine( embed(query), embed(passage) )`. The two sides are deliberately asymmetric:

### The query
The **intent string** — the natural-language question the grow is run for (`--intent`). A retrieval model
of the BGE family wants an instruction prefix on the query (`Represent this sentence for searching relevant
passages: …`); MiniLM/mpnet want none. The prefix is applied to the **query only**, never the passages.

### The passage
Each repo def is turned into one **passage** by `embedString` (`src/codebase/scan/def_table.ts`):

```
[method ]<signature | name>[ in <enclosing class>] — <file path>[ :: <leading doc-comment>]
```

so the passage carries, in order:

| Part | Example fragment | Why it's in the passage |
|---|---|---|
| kind tag (methods only) | `method ` | a method's signature has no leading keyword, so tag it |
| **signature or name** | `chargePayment(amount: number)` | the symbol's identity and shape |
| **enclosing class** | ` in PaymentsBean` | disambiguates a generic name by its owner |
| **file path** | ` — ejb/.../xplan/XPlanRestExportProcessor.java` | the strongest domain signal: a path carries `/xplan/`, `/docusign/`, `/projection/` so an intent about "XPLAN" embeds near the XPlan files and far from the schema/projection ones |
| **leading doc-comment** | ` :: charge the customer's card for the order total` | the concept the bare name omits |

The function **body is deliberately not embedded** — the name + signature + enclosing + path + doc are a
compact, high-signal summary; the body adds tokens and noise. The file path doing real work is *why* this
ranks well on opaque codebases: even when a symbol name is generic, its path usually isn't.

### Per-seam relevance
A grown seam is scored by its **primary def's** passage (the seam's anchor/core symbol — `seam.primary
.{file,symbol}`, matched to a def by `file::name` with a name-only fallback). One known limitation: a
multi-symbol seam is judged by its *primary* only; a relevant secondary symbol can be missed if the primary
is generic. A future upgrade is to embed *all* of a seam's symbols and take the max (same machinery).

## What it emits

`annotateIntentRelevance` (`src/codebase/grow/intent_rank.ts`) attaches to each seam:

- **`relevance`** — the cosine score (0..1), rounded.
- **`tier`** — a **rank-banded** label: top third `spine`, middle `supporting`, tail `off`. Banding is by
  *rank*, not an absolute cosine threshold (which drifts per repo/model), so low absolute scores don't
  matter — only the ordering does.

Relevance is **orthogonal to `role`**: `role` (core / link / environment / test) is a *structural* property
(decides-vs-connects); `relevance`/`tier` is *intent-similarity*. A seam can be a `link` and on the `spine`.

It is **additive** — it annotates only; it never drops or reorders seams. The full closure is always
emitted. Cropping is a separate, opt-in consumer choice (`--spine-only`, below).

## `--spine-only`

An opt-in **view** for an LLM consumer that pays per token. It crops the `off` band using the deterministic
tier (still 100% reproducible — it's the embedding ranking, **not** an LLM), keeping `spine` + `supporting`
in full. It is **honest and lossless-by-reference**: dropped seams survive as compact stubs
(`{label, relevance, file}`) in `cluster.omitted`, and the run reports the omitted count — nothing is
silently hidden, and the caller can re-query without `--spine-only` for the full closure. It **no-ops to the
full closure** when embeddings are unavailable (never crops blind). Full output is strictly more robust (the
consuming model sees everything and can override the ranking); `--spine-only` trades that for fewer tokens —
a conscious, opt-in choice.

## Where it's used

- **Anchor recall** — `embed_anchor_candidates` (`src/codebase/anchor/anchor_embed.ts`) surfaces an anchor
  whose name doesn't lexically match the intent. Additive over the lexical floor; the LLM judge still
  selects. Embeddings **rank** reliably but single-best **selection** is weaker than an LLM judge, so this
  is a recall floor, not a verdict.
- **Grow intent-ranking** — `annotateIntentRelevance` / `cropOffIntent`, as above.

Both go through the one scan-layer primitive `embedScoreDefs(repo, intent)` (so anchor and grow share it
with no layering back-edge).

## Determinism, cost, honesty

- **Deterministic** — same model + same code → same vectors → same ranking. No sampling.
- **Cost** — first intent-grow on a repo embeds the def table once (~10 s for ~1.3 k defs), then it's
  cached/incremental. No API call; cheaper and faster than an LLM relevance pass.
- **Honest** — a recall *floor*, not a sharp pick. The tier is a *highlight*, never a deletion (default);
  `--spine-only` makes the crop explicit and reports what it omitted. The spine does **not** surface as a
  single deterministic graph *path* (shortest-path collapses through import hubs) — the relevance *ranking*
  is the deterministic spine signal, not an ordered path.
