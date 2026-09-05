# DISCARDED — the pilot round, kept because it is what fixed the apparatus

Not averaged into anything. Two defects, both found here rather than after five rounds of spending:

1. **Arm C was contaminated.** It walked all five replay steps and then ran `sed`, `ls` and four `grep`s.
   Only the greps were denied — because only grep was NAMED in the deny list. `--allowedTools` /
   `--disallowedTools` are ADVISORY for the shell: granting `Bash(<path>/call-flow:*)` permits Bash
   generally. This is the FOURTH time this project's benchmark control has broken this exact way. Fixed by
   naming every shell read verb (`NO_SHELL_READ` in run-arms.sh) and by auditing what actually ran
   (`contamination()` in measure.py) rather than trusting the flags.

2. **Thinking was still unmeasurable.** `--include-partial-messages` does emit `thinking_delta` events, but
   their `thinking` text is REDACTED. They carry `estimated_tokens`, which IS the measurement, and
   measure.py now reads that instead of counting characters.

Arm A of the first attempt ran under a script that was edited mid-flight (the round died with a syntax
error), so its 101s is an apparatus artefact — though it lands right on the kcC grep baseline of 105.7s,
which is the one useful thing this round says: the harness is comparable to the one it exists to explain.

**And one result worth keeping in view.** The contaminated arm C, handed a PERFECT zero-latency oracle, still
made 21 further calls (12 of them `Read`) verifying what it had been told, took 103s, and cost $1.73. That is
the "richer output does not buy fewer calls" finding in its strongest available form — but it is n=1 and it is
dirty, so it is a reason to run the clean rounds, not a result.
