# Anchor selection

The step before every shape, and the one nothing measured.

    bun bench/anchor-select/run.ts [caseId…] [--trials=N]

## Why

`bench/grep-vs-seam` replays the commands an agent actually ran, so it can only score answers to questions the
agent thought to ask. Replaying the keycloak trace showed the agent never found that case's declared anchor at
all: it guessed `--center` twice from the prose task, landed on the TypeScript side once and a 28-line dead end
the other time, and paid 21 RECALL commands afterwards. Anchor choice is upstream of every shape, every ranking
fix and every coupling improvement — and no harness could see it.

Scoring is at **file granularity** on purpose. `grep` finds files, not `file#symbol`; scoring it on a symbol
address it never claims to produce would rig the comparison.

The ground truth is the `anchor` field in `bench/grep-vs-seam/cases.json`, fixed before this harness existed. It
is **one defensible answer, not the only one** — the judges pick a mechanism *cluster*, and on keycloak they
chose `{Realms, refresh, loader}` where the declared anchor is `RealmModel`. That is a different reading of the
same question, not obviously a wrong one. The harness therefore prints what each arm picked next to its rank, so
a rank alone cannot launder that judgement call into a score.

## The result that killed `--locate-intent` (2026-07-31)

`--scan --intent` picks the anchor itself via two LLM judge passes. Measured over four uncached keycloak runs:
**18s–81s, and a different mechanism cluster on 1 run in 4.** A `centers-v1` cache exists purely to freeze one
sample so grows stay reproducible — and a stale entry in it is what made an earlier measurement in this repo
report a frozen historical anchor as if it were current behaviour.

That nondeterminism motivated a deterministic alternative: `--locate-intent`, which ranked candidate defs by
lexical overlap between the intent phrase and identifier names, then fan-in. It was built, tested, gated, and
**deleted the same day.** This harness is why:

    ── private-app-cn-consumers                (anchor lib/utils.ts)
       locate   rank —  of 23    0.2s   → components/social-media-selector.tsx
       judges   rank 8  of 129   36.0s

    ── grep-favourable-unique-symbol    (anchor lib/types/index.ts)
       locate   rank 2  of 2     0.2s
       judges   rank —  of 114   63.5s

`locate` did not rank the `cn` anchor low — it **never returned it**. The tokenizer took alphanumeric runs of 3+
characters, so `cn` was not a token at all, and the ranking fell back to "components / class / name / helper".

The general form of that failure is the reason it is gone, and it is not fixable by widening the tokenizer:

- **Lexical overlap is language-bound.** A French intent phrase over English identifiers scores zero. English
  over a Chinese codebase scores zero. Intent→code is a *semantic* mapping.
- **It breaks within one language too** — abbreviations (`cn`), compounds, and stems (`"persisted"` does not
  match `persist`).
- **Every other Seam command is structural** — imports, calls, implements/extends, shared keys. A string-
  similarity ranker in that command table implies a grounding it does not have.

`center_repo.ts` says this in its own header ("keyword-matching def NAMES is the wrong primitive for it: a verb
like `managed` matches management code everywhere"). It was read, quoted, and then contradicted anyway. If you
are about to rebuild a lexical anchor picker, this paragraph is for you.

**`--locate <name>` is unaffected** and remains the right primitive: exact-name address resolution is structural,
it forms no opinion, and it prints every definition rather than picking one.

## …and then the judges were removed too (same day)

The conclusion above — "the LLM judge is the right primitive, its defect is reproducibility" — was half right and
the half that was wrong mattered more.

A 3-sample consensus panel was built to fix the reproducibility: k independent judge calls in parallel, majority
kept, the vote reported so a split panel says so. It was then A/B'd against the single-sample judge on keycloak,
cache cleared every run:

    k=1:  {Realms, AdminRoot}   {Realms, refresh}   {Realms, AdminRoot}
    k=3:  {Realms, refresh}     {Realms, AdminRoot} {Realms, AdminRoot}

**Two distinct outcomes in three runs, in both arms.** Aggregation moved nothing measurable, and it was reverted
rather than shipped on the strength of a plausible mechanism.

The reason it could not work: the defect was never sampling noise. It was a **semantic choice made inside a tool
whose whole claim is a deterministic fact set**. Voting three times is still an LLM picking the center; it just
costs 3× the tokens to be non-reproducible more expensively.

So `--intent` now REQUIRES `--center`, and the two judge passes, the `centers-v1` cache, `center_judge.ts`,
`center_repo.ts` and its parity harness are gone. The caller picks the anchor — and the caller is an agent with
the user's real task, the conversation and its own prior findings, where the judge had an intent phrase and a
bounded candidate list. `--intent` still ranks and tiers a grow; it no longer chooses where to look.

Still orphaned by that removal, verified as having zero TypeScript callers but NOT yet deleted (a rebuild plus a
wider gate than this change needed): `seam_grow::center_repo` in Rust, and its two napi entries
`grow_source_dirs` / `grow_center_candidates`.

## What to measure next

This harness outlives both deletions. It is arm-agnostic: point it at whatever picks anchors next — an agent
given `--locate` output, a different retrieval, a human — and it scores that the same way it scored these.

The open question it was built for is still open: **does an agent anchor better with Seam's help than without
it?** Both Seam-side arms are now gone, so today the honest answer is that the agent is on its own, and nobody
has measured whether that is worse.

## Guards

The harness aborts rather than publishing a confident zero when an arm returns nothing on every case. That fired
on its first run: `--locate-intent` scored 0 files everywhere because the arms were shell-quoted with
`JSON.stringify`, which emits **double** quotes, inside which the shell still runs command substitution — and the
task strings contain backticks (`` `IntegrityReport` ``), so the phrase reached the CLI empty. A benchmark that
silently passes an empty question to one arm is not measuring that arm.
