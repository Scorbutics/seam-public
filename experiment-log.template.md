# Seam experiment log — §8.2 tool vs. discipline

Copy this file per experiment (e.g. `experiment-2026-06-04.md`) and fill it **in order, top to bottom**. The "before you look" section is the lie detector — it only works if written *before* opening anything.

The ONE question this answers: **is reviewing-by-role-without-scrolling _dramatically_ better than the manual decomposition that already beats linear review?** Dramatic → the tool is the product. Marginal → the value was the discipline, and the deliverable is a written method.

---

## 0. Pick the change
- Repo / commit (or range): `____________`
- **Must be REAL and tangled** (legacy or AI-authored), and **one you have NOT already reviewed or dissected** — otherwise the prediction is contaminated. (So: *not* a diff we analysed together.)
- Size: ~___ hunks, ___ files.

## 1. Before you look — predict FIRST
- Predicted **linear** review:  time ___ min · trust afterward (0–10) ___
- Predicted **by-role** review: time ___ min · trust afterward (0–10) ___
- In one line: what do you expect to be the **hardest thing to verify** here? `____________`

## 2. Review #1 — LINEAR (plain diff, top-to-bottom, file by file)
Do this on the raw diff, **no Seam**. Then take a real break before #2.
- Actual time: ___ min · trust afterward (0–10): ___
- "Why is this here?" moments / where you scrolled back to reconstruct context: `____________`
- Anything you MISSED and only caught later: `____________`

## 3. Review #2 — BY ROLE (open the Seam report)
Generate: `~/dev/code-review-sort/decompose-here.sh <commit>` (from the repo dir).
- Actual time: ___ min · trust afterward (0–10): ___
- Did the cluster/seam grouping match how *you'd* have grouped it? where not: `____________`
- Did co-located core/link/env cut the jump-to-call-site switching? `____________`
- Any seam you DISTRUSTED (uncertain badge / wrong role / odd env-vs-core) — did it actually cost you, or did your self-check absorb it? `____________`

## 4. Verdict
- By-role vs linear: **dramatically better / marginally better / same / worse**
- Was the value the **TOOL** or the **DISCIPLINE** (would hand-writing the decomposition have delivered it)?
- Decision: **tool is the product**  /  **the method is the product (write it up)**
- Next change worth re-testing on: `____________`
