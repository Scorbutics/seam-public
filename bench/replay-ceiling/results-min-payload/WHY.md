# Arm E — the minimal-payload oracle

Run `compare.py` in this directory for the numbers; this file does not copy them. `verify_independent.py`
re-derives the figures the paper quotes.

## The question

Arm C's oracle is optimal on latency, step order and recall, but not on **size**: it serves Seam's real output,
about 13k tokens. The paper called it an upper bound on every retrieval tool that answers by injecting a
payload. That only holds if a smaller payload could not do better. Arm E tests it: arm C with only the payload
changed — one step holding only the answer (the ground-truth locations as `file:line#symbol` plus the REST
crossing, 1.7 KB), then `DONE`. Same prompt wording, denials and allowed verbs as C, no search.

## What is not like arm C

Arm C's content is a real tool's recorded output. Arm E's is **hand-built from `truth.txt`**, with line numbers
read at keycloak `cd0b33e528`. It is the best conceivable answer, not any tool's output: a real tool would have
to find and disambiguate these locations itself (`getRealm` has 207 definitions). Arm E is therefore a more
idealised bound than arm C, on content as well as size.

## The rig

Arms A, C and E ran together, five paired rounds in randomised order, on `claude-opus-5[1m]`, CLI 2.1.303 with
`--add-dir`, keycloak `cd0b33e528` for every round (`eN.repo`). Only comparisons inside this directory are
paired.

## Apparatus

Two calls the arms had been granted were refused, both in round e1: one compound command in the control
(`cd … && grep … | head; echo …; grep …`) and one `awk` with a complex regex in arm C. That is 2 of about 420
calls, not the working-directory confinement that discarded earlier batches, and most likely the CLI's
permission parser rejecting unusual syntax. They are reported rather than hidden. Without round e1 the result
is unchanged (E against grep 0.43x, C against grep 1.32x).

## What it found

- **The minimal-payload oracle beats grep clearly**: about 0.45x the control's cost, cheaper in all 5 rounds,
  and far cheaper than arm C (paired). Its cache write is lower than the control's. So arm C was not a bound
  on the class: it was a bound on tools that return a payload of its size.
- **The verification floor is still there.** With the whole answer in its first call, the agent still ran
  about 10 checks after `DONE` on average — and 25 in one round, where its cost rose to the control's level.
  The floor does not erase the gain; it caps it and makes it vary from round to round.
- **This is what §4.2's arithmetic predicted.** The kcC break-even said a payload pays for itself only under
  about 6.8k tokens. Arm C's is about 13k; arm E's about 0.5k.
- Arm C on this rig loses again (about 1.25x raw, 1.07x adjusted), in the same direction as the published
  rounds.
