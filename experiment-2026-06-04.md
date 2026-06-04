# Seam experiment log — §8.2 tool vs. discipline

Copy this file per experiment (e.g. `experiment-2026-06-04.md`) and fill it **in order, top to bottom**. The "before you look" section is the lie detector — it only works if written *before* opening anything.

The ONE question this answers: **is reviewing-by-role-without-scrolling _dramatically_ better than the manual decomposition that already beats linear review?** Dramatic → the tool is the product. Marginal → the value was the discipline, and the deliverable is a written method.

---

## 0. Pick the change
- Repo / commit (or range): private-app_app: `b3792ef84c1d71e8cc18a648b5d0fe69a5db8216~..b3792ef84c1d71e8cc18a648b5d0fe69a5db8216`
- **Must be REAL and tangled** (legacy or AI-authored), and **one you have NOT already reviewed or dissected** — otherwise the prediction is contaminated. (So: *not* a diff we analysed together.)
- Size: ~27 hunks, 15 files.

## 1. Before you look — predict FIRST
- Predicted **linear** review:  time 15 min · trust afterward (0–10) 4
- Predicted **by-role** review: time 10 min · trust afterward (0–10) 6
- In one line: what do you expect to be the **hardest thing to verify** here? `It's a quite easy review, UI code only. This should be pretty well loose coupled using components. Hard part is understanding how everyting is working altogether`

## 2. Review #1 — LINEAR (plain diff, top-to-bottom, file by file)
Do this on the raw diff, **no Seam**. Then take a real break before #2.
- Actual time: 9 min · trust afterward (0–10): 6
- "Why is this here?" moments / where you scrolled back to reconstruct context: `3 or 4 times, because few parts are linked together and some are at the bottom of the files, others are at the beginning of the commit changes`
- Anything you MISSED and only caught later: `I didn't pay attention that the cookies were linked to the sidebar (I just scrolled and read but only focused on the line edit code quality and didn't see we were in the sidebar)`

## 3. Review #2 — BY ROLE (open the Seam report)
Generate: `~/dev/code-review-sort/decompose-here.sh <commit>` (from the repo dir).
- Actual time: 7 min · trust afterward (0–10): 7 - 8
- Did the cluster/seam grouping match how *you'd* have grouped it? where not: `Yes in the major part. As I have said, this is a UI code diff with components, and it's easier to mentally picture. But, I was surprised by 2 seams: 1 referring an actual integration component and its location with links: ConsentAwareSidebarProvider, which is directly linked to the `writeCookie` boolean all along the line until it reach the final `document.cookie` inside its own `SidebarProvider`. This display is very clean and helped understanding a lot`
- Did co-located core/link/env cut the jump-to-call-site switching? `Yes absolutely`
- Any seam you DISTRUSTED (uncertain badge / wrong role / odd env-vs-core) — did it actually cost you, or did your self-check absorb it? `yes, one seam contained a `CookieConsentDialog` component and a link that was related to another, but close, component (`CookieConsentBanner`). The thing is, those 2 seams were wired, so it was really easy to spot. Of course, the best scenario would be to have everything in the same seam in this case, but it also makes sense to make them smaller and separate.`

## 4. Verdict
- By-role vs linear: **dramatically better / marginally better / same / worse**
    I will have to nuance.
    The PR itself is not really bad to review line by line. It's okay. I didn't have to deploy a lot effort to review it.
    I did fell on several "trap" while reviewing the PR linearly though: all those quite similar names "CookieConsentDialog", "CookieConsentBanner", "ConsentAwareSidebarProvider"... gave me a hard time to draw the link between them, on this PR particularly, because they all sound the same and they were not exactly all used at the same place in the PR.
    I also didn't notice few changes that the clustering showed me instantly on the decomposition very.
    But I will be honest, it takes a long time to generate (around 3 minutes), and the gain is not huge (gained 1 minute and 1 or 2 trust points). That's still a gain on both sides though, which sounds interesting.
    And the friction is still high without a proper IDE extension.
    So, marginally better more than dramatically better? for now, clearly marginally, but the foundations provide great results.
- Was the value the **TOOL** or the **DISCIPLINE** (would hand-writing the decomposition have delivered it)?
    To be honest, yes. If you write everything by hand by first categorising the hunks and rebuilding the seams, this could provide the same result.
    But it would not provide "code locality" changes reviewing by the created seams (the output of the renderer).
    And it feels like a big work.
- Decision: **tool is the product**  /  **the method is the product (write it up)**
    I think the tool is the product. It is not possible to mentally picture all the seams and categorise everything. And that's the threshold.
- Next change worth re-testing on: `the backend counterpart of this PR, a refactoring: private-app_backend, commit id: 39ae5c9434eb1260be277bb3e1813976d1286315`
