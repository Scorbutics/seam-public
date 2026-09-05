# DISCARDED — three rounds run under an asymmetric tool grant that BIASED TOWARD THE CONCLUSION

r1 and r2 complete, r3 partial. Not averaged into anything. Kept because the defect is worth recording and
because they double as a sensitivity check (see below).

## The defect

Reacting to the pilot's contamination (arm C ran `sed`, `ls` and four `grep`s), `NO_SHELL_READ` was added and
applied to arms B and C. It named every shell verb that reads the repo — `grep rg egrep fgrep ag ack sed cat
head tail ls find awk cut sort uniq comm wc python3 python perl`.

**Arm A kept all of them.** So the control could page a 50 KB Java file with `sed -n '430,500p'` while the two
treatment arms could only open it whole with `Read`. That is not the capability under test. The pilot's real
problem was arm C reaching for **grep** — content search — which was already denied and already blocked. The
`sed`/`ls` usage was legitimate file reading, and blocking it made the treatment arms pay whole-file token
costs the control never paid.

## Why it had to be re-run rather than caveated

The bias runs **toward this study's conclusion**. The finding under test is that a structural tool cannot lower
token cost, and the defect inflates exactly the treatment arms' token cost. A result that would have been
reported as a finding was partly manufactured by the harness. The direction is what makes it disqualifying: a
bias against the conclusion could be reported as a conservative bound, and this one cannot.

Arm C was also charged 6-8 **denied** calls per round — turns spent discovering a restriction that no real user
faces, and that the control cannot trigger. `bench/grep-vs-seam`'s header records the identical mistake being
made and reverted once before (the PATH shim, removed for charging arm SEAM more shimmed verbs than arm GREP).
This is the second occurrence in the same project.

## The fix

The ONLY difference between arms is now CONTENT SEARCH. Every arm gets the same read/list verbs
(`cat sed head tail ls find wc sort uniq cut awk comm`) and `Read`; only arm A additionally gets
`rg`/`grep`/`Grep`/`Glob`.

## What these rounds are still good for

They are a real measurement of a real (if unintended) configuration: *what a structural tool costs when the
agent cannot page files cheaply.* Read that way, r1-r2 say the effect this study reports gets LARGER under a
read-expensive regime — arm C at 1.50x the control's cost, arm B at 1.53x, against 1.17x in the kcC batch.
That is a sensitivity direction, not a result.

| r1-r2 mean | GREP | SEAM | REPLAY |
|---|---|---|---|
| tool calls | 24.5 | 16.0 | 26.5 |
| turns | 25.5 | 17.0 | 27.5 |
| cost | $0.99 | $1.51 | $1.48 |
| blocked (apparatus) calls | 0.0 | 1.5 | 7.0 |
