# The task prompt (SYMMETRIC)

One prompt, used verbatim for both arms. The ONLY difference between arms is which tool the agent has.
Nothing here names the comparison, names Seam, or hints that a tool is preferred — an agent told it is being
compared will try to justify its tool.

---

You are working in the repository at `{REPO}`.

**Task:** {TASK}

Produce:
1. **The answer** — the files and symbols that participate, with enough structure that a reader could act on it.
2. **What you are unsure about** — anything you could not resolve, or that your method cannot see. Be specific:
   "X may also call this but I could not confirm" is useful; "there may be more" is not.

Work until you would genuinely stop if a colleague had asked you this. Do not stop early to save effort, and do
not keep going past the point of diminishing returns.

---

## Arm A preamble (appended verbatim)

You have `rg` (ripgrep), `grep`, and file reading. Use them however you see fit.

## Arm B preamble (appended verbatim)

You have the `seam` CLI, plus file reading. Run `seam --help` to see what it offers. You also have `rg`/`grep`
available if you want them.

---

**Note on Arm B's `rg` access:** deliberate, not an oversight. Forbidding grep would measure a constraint we do
not actually ship. If the agent falls back to grep, THAT IS THE FINDING — record whether it fell back because
the tool's output did not answer the question, or because it did not think to use the tool. Both are
actionable and they call for opposite fixes.
