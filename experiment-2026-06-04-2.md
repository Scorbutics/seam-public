# Seam experiment log — §8.2 tool vs. discipline

Copy this file per experiment (e.g. `experiment-2026-06-04.md`) and fill it **in order, top to bottom**. The "before you look" section is the lie detector — it only works if written *before* opening anything.

The ONE question this answers: **is reviewing-by-role-without-scrolling _dramatically_ better than the manual decomposition that already beats linear review?** Dramatic → the tool is the product. Marginal → the value was the discipline, and the deliverable is a written method.

---

## 0. Pick the change
- Repo / commit (or range): `private-app_backend 39ae5c9434eb1260be277bb3e1813976d1286315~..39ae5c9434eb1260be277bb3e1813976d1286315`
- **Must be REAL and tangled** (legacy or AI-authored), and **one you have NOT already reviewed or dissected** — otherwise the prediction is contaminated. (So: *not* a diff we analysed together.)
- Size: ~11 hunks, 7 files.

## 1. Before you look — predict FIRST
- Predicted **linear** review:  time 10 min · trust afterward (0–10) 5
- Predicted **by-role** review: time 5 min · trust afterward (0–10) 6
- In one line: what do you expect to be the **hardest thing to verify** here? `This is a rewrite of the billing pipeline, it includes a mail, some external API calls and a client creation. It will be hard to scroll up and down through all the changes.`

## 2. Review #1 — LINEAR (plain diff, top-to-bottom, file by file)
Do this on the raw diff, **no Seam**. Then take a real break before #2.
- Actual time: 9 min · trust afterward (0–10): 6
- "Why is this here?" moments / where you scrolled back to reconstruct context: `a LOT, more than expected. At some point I saw a structure but didn't know where it was used. I had to CTRL+F around 20 to 30 times to bounce between the code diffs.`
- Anything you MISSED and only caught later: `Not a lot to be honest. I missed 1 field that was added (the address of a Stripe customer), and the fact we are polling the API to wait for the PDF to finish its download. But as I took my time (almost 10 minutes), I didn't miss a lot`

## 3. Review #2 — BY ROLE (open the Seam report)
Generate: `~/dev/code-review-sort/decompose-here.sh <commit>` (from the repo dir).
- Actual time: 7 min · trust afterward (0–10): 6 - 7
- Did the cluster/seam grouping match how *you'd* have grouped it? where not: `Yes, completely`
- Did co-located core/link/env cut the jump-to-call-site switching? `Yes, except for one case where I didn't see the actual definition because it was located inside another seam (which makes sense, but could be indicated one day)`
- Any seam you DISTRUSTED (uncertain badge / wrong role / odd env-vs-core) — did it actually cost you, or did your self-check absorb it? `Not this time`

## 4. Verdict
- By-role vs linear: **dramatically better / marginally better / same / worse**
    - In this case, I can admit that this PR contained a LOT of pure core creation, meaning that the hunks were BIG and that's why the current outcome / gain of the tool is pretty low.
    This is definitely the "marginally better" scenario, it's a bit better than the file by file review as it's linking few things together, but there are only 3 seams generated (correctly) and 2 of them are linked.
- Was the value the **TOOL** or the **DISCIPLINE** (would hand-writing the decomposition have delivered it)?
    This is still the TOOL (code locality)
- Decision: **tool is the product**  /  **the method is the product (write it up)**
- Next change worth re-testing on: `____________`
