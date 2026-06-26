# P3 coupling strategy — design (#2′)

> The grow's **P3** phase (docs/grow-architecture.md) finds cross-boundary data-flow bridges. This doc is
> about P3's **internals** — which we can now change without touching P2/P4. It exists because Brice's feeling
> is right: coupling discovery is *harder than it should be*, and the reason is architectural, not essential.

## The core realisation

**Discovering a coupling is easy; the flywheel is hard.** The LLM is excellent at "what key does this code
produce/consume, who's the counterpart." What hurts is the machinery built around it to make the answer
**deterministic, cached, and warm-free**:

- a **constrained-IR adapter** the LLM must emit (not "the keys" but "a reusable rule"),
- a **self-validation loop** (synth → re-execute → ground → feed back the misses → retry),
- a **matcher store** persisted to `.seam` so warm runs replay.

That's the flywheel, and it's most of the complexity. It buys *warm-free determinism at scale*. The question
is whether you need that, given the LLM calls are the Claude **subscription**, not the paid API.

## Current P3 layers

| Layer | Kind | Cost | Notes |
| --- | --- | --- | --- |
| Floor adapters (Supabase `.from`, member-access ORM, http_route, annotation_route) | deterministic | free | covers the common shapes; keep |
| Carrier trace | deterministic | free | follows a value through assigns; keep |
| `discover-keys-batch` (per-file) | LLM | N calls | "list the keys in this file" — simple; **opt-in today** (`SEAM_PER_FILE_KEYS`) |
| `discover-key-matchers` (cluster→shape) | LLM + **flywheel** | few calls | the constrained-IR synth + self-validate + cache; **default today** |
| `classify-receivers` / `classify-annotations` | LLM | few calls | receiver/annotation → repository/channel/annotation matchers |
| Grounding (literal co-occurrence) | deterministic | free | a key is real only if it appears on BOTH sides; keep |

The floor + grounding are cheap and good. The **three LLM front-ends overlap**, and the matcher one carries
the flywheel weight.

## The key fact that makes this safe

`SEAM_KEY_AUDIT` on cal.com (from earlier this session): the per-file pass and the matcher pass produce the
**same grounded couplings** — `UNIQUE to per-file pass: 0`. So the flywheel and the simple per-file path are
**recall-equivalent** on that corpus. The flywheel's only edge is *fewer LLM calls* (clustering) and
*warm-free determinism* (the cache) — not better discovery.

## The options

**A — Keep everything (status quo).** Flywheel default. Fewest LLM calls, warm-free, but the complexity you're
fighting stays.

**B — Simplify to floor + ONE simple LLM pass (LLM-per-run).** Keep floor + grounding. Replace the matcher
flywheel *and* the classifiers with a single pass: over the footprint's uncovered files, **cluster by shape**
(keep the cheap clustering — it's what cuts 300 files → ~15 calls), then ask the LLM per cluster *"what keys
does this produce/consume, and the kind"* — plain JSON, **no constrained IR, no self-validation, no matcher
store**. Ground by co-occurrence. Cache the per-cluster answer by **content hash** (simple warm skip, not a
compiled adapter). The flywheel stays in the tree behind `SEAM_COUPLING=flywheel` for scale/determinism, but
is no longer the default.

**C — Rip the flywheel out entirely.** Smaller tree, but throws away the warm-free path with no fallback.

## Recommendation

**B.** It directly answers "let the LLM work for me": you ask, it tells you, you ground it — the clustering
keeps it cheap, content-hash caching keeps warm runs free for unchanged files, and you keep the deterministic
floor for the common cases. It's recall-equivalent to the flywheel (audited), reversible (flywheel stays
opt-in), and it's a **P3-internal change** — P2/P4 and `_anchorCouplingDelta`'s contract are untouched, so the
grow_contract oracle stays green and any change is a reviewed P3 diff.

Not C: keeping the flywheel opt-in costs nothing and preserves the scale path for a future big-monorepo case.

## The one decision for Brice

**Do we go B (simple LLM-per-cluster default; flywheel demoted to opt-in)?** If yes, the migration is:

1. **Pin** current coupling grounding on the fixtures (a P3 oracle — keys produced/consumed per case), so the
   strategy swap is provably recall-equivalent, not a silent drop.
2. **Add** the simple per-cluster LLM pass (mostly already present as the per-file path + the clusterer).
3. **Flip** the default: simple pass ON, flywheel behind `SEAM_COUPLING=flywheel`. Validate recall on cal.com
   against the Step-1 pin (must match).
4. **Leave** floor + grounding + carrier untouched.

Open sub-question for step 2: per-**file** vs per-**cluster** LLM granularity. Per-cluster is the cheap one
(the globex "300 files → 15 shapes" win) and is the recommended default; per-file stays available for a repo
where clustering misfires.
