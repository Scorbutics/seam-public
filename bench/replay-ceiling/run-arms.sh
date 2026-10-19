#!/usr/bin/env bash
# THREE ARMS on ONE question, to answer: is the gap RETRIEVAL, or is it the agent loop?
#
#   bench/replay-ceiling/run-arms.sh <round-id>
#
#   A  grep      the control — ripgrep + reads, no structural tool
#   B  seam      the real product, with its real SKILL.md, as bench/grep-vs-seam runs it
#   C  replay    the CEILING — canned Seam output served by `call-flow --step N`, zero latency,
#                zero wrong turns, ~300 bytes of doc. See ./call-flow for why this is an upper bound.
#
# EVERYTHING that must be identical is set once here: task, repo, output contract, turn budget, MODEL.
# The model is PINNED (bench/grep-vs-seam left it to the launcher's default, which is an open question a
# reader is entitled to ask). The three arms run BACK TO BACK in one invocation, so the repo state is the
# same commit for all three by construction.
set -u
ROUND="${1:?usage: run-arms.sh <round-id>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# OUT is overridable so a PROBE (a different model, a spike) cannot land in the results directory the
# paper reads. ARMS likewise: re-running one arm, or running a two-arm probe, should not mean editing
# this file — an edited harness is a different harness.
OUT="${OUT:-$HERE/results}"; mkdir -p "$OUT"
ARMS="${ARMS:-ABC}"
ROOT="$(cd "$HERE/../.." && pwd)"
REPO="${REPO:-$HOME/dev/keycloak}"
SEAM="$ROOT/ts/src/cli/decompose.ts"
MODEL="${MODEL:-claude-opus-5[1m]}"

# The task, verbatim from bench/grep-vs-seam/cases.json#keycloak-cross-language. Not reworded.
TASK="How does the admin UI read and update a realm — trace it from the TypeScript admin client to the Java server side."

# Identical output contract for all three arms — the reason precision is scoreable at all.
CONTRACT=$(cat <<'EOF'

When you are done, end your reply with a section in EXACTLY this format and nothing after it:

## ANSWER
path/to/file.ext#symbolName
path/to/another.ext#symbolName

One `file#symbol` per line, repo-relative paths, no bullets, no commentary inside the block. List EVERY
location you are claiming — this block is the answer; the prose above it is only your reasoning. If you are
unsure about an entry, still list it, and say why in the prose. Do not pad the list with locations you do not
believe: you will be scored on precision as well as completeness.
EOF
)

export SEAM_REPO_CACHE_DIR="${SEAM_REPO_CACHE_DIR:-/tmp/seam-bench-cache}"
mkdir -p "$SEAM_REPO_CACHE_DIR"
# Arm B is the only arm with a cache, and a cold one would charge it for a rebuild no real user pays. Replay
# the commands prior runs issued (see prewarm.sh) before every round, so B starts warm and STAYS comparable
# round to round. Skipped when PREWARM=0.
[ "${PREWARM:-1}" = "1" ] && "$HERE/prewarm.sh" >/dev/null 2>&1

# Session-inherited tools are denied to EVERY arm in identical words: an agent that spawns a subagent is not
# exercising grep, Seam, or the replay, and counting those measured the harness (bench/grep-vs-seam, 4x).
# THE ONLY DIFFERENCE BETWEEN THE ARMS IS THE SEARCH CAPABILITY. Nothing else.
#
# Denied to arms B and C: the SEARCH family, and only that. `--allowedTools`/`--disallowedTools` are ADVISORY
# for the shell — granting `Bash(bun:*)` or `Bash(call-flow:*)` evidently permits Bash generally, which
# grep-vs-seam measured three times and this harness's PILOT reproduced. So a verb that must not be reachable
# has to be NAMED, and then AUDITED in the transcript (contamination() in measure.py), because naming it is
# still only advisory for anything it did not anticipate.
#
# WHAT IS *NOT* DENIED, and the correction that cost a five-round batch (see results/discarded-strict-read/):
# the READ and LIST verbs — sed, cat, head, tail, ls, find. A first cut denied those to B and C as well. Arm A
# kept them, so the treatment arms had to pull a WHOLE FILE through `Read` wherever the control could
# `sed -n 430,500p`, and every arm-C round paid ~7 extra turns for refused commands on top. That inflated the
# treatment arms' token cost — IN THE DIRECTION OF THE STUDY'S OWN CONCLUSION, which is the one direction a
# bias must never point. Reading a file is not the capability under test; FINDING it is.
NO_SEARCH=("Bash(grep:*)" "Bash(rg:*)" "Bash(egrep:*)" "Bash(fgrep:*)" "Bash(ag:*)" "Bash(ack:*)"
           "Bash(fd:*)" Grep Glob)
COMMON_DENY=("Bash(sleep:*)" Agent Task TaskCreate TaskUpdate TaskList TaskGet TaskOutput TaskStop
             ScheduleWakeup ToolSearch CronCreate WebSearch WebFetch Skill Workflow Edit Write NotebookEdit)

run_arm () {  # run_arm <letter> <prompt-var> <deny-array-name> <allowed-tools...>
  local letter="$1"; shift
  local -n prompt="$1"; shift
  local -n deny="$1"; shift
  local scratch="$OUT/.scratch-$letter"; rm -rf "$scratch"; mkdir -p "$scratch"
  local started ended
  started=$(date +%s)
  # --add-dir "$REPO": since a Claude Code version between 2.1.239 and 2.1.270, Bash is confined to the working directory plus --add-dir
  # directories, so a repository outside the harness had its shell verbs REFUSED even when granted — silently,
  # and hardest on the grep control (results-oracle-grep/discarded-outside-workdir/WHY.md). 2.1.239, which ran
  # the published rounds, did not enforce this. Identical for every arm.
  # --include-partial-messages is what makes THINKING measurable: stream-json alone stores thinking blocks
  # with EMPTY content, which is why the earlier benchmark could only ever report total output tokens and
  # the "thinking went up" reading was never directly evidenced.
  claude -p "$prompt" \
    --model "$MODEL" \
    --output-format stream-json --verbose --include-partial-messages --max-turns 60 \
    --add-dir "$scratch" --add-dir "$REPO" \
    --allowedTools "$@" --disallowedTools "${deny[@]}" \
    > "$OUT/$ROUND.$letter.jsonl" 2>"$OUT/$ROUND.$letter.stderr"
  ended=$(date +%s)
  echo "$((ended - started))" > "$OUT/$ROUND.$letter.secs"
  echo "  arm $letter: $((ended - started))s -> $OUT/$ROUND.$letter.jsonl"
}

# ── ARM A: grep ──────────────────────────────────────────────────────────────────────────────────────────
PROMPT_A="You are working in the repository at $REPO.

TASK: $TASK

Use ripgrep/grep and file reads to answer. Work from the repo root: $REPO

A scratch directory you may write to (identical for every arm): $OUT/.scratch-A
  — use it if you want to save output to a file rather than re-running a command.
$CONTRACT"
DENY_A=("${COMMON_DENY[@]}" "Bash(bun:*)" "Bash(node:*)" "Bash(npx:*)" "Bash($HERE/call-flow:*)")
ARM_A () { run_arm A PROMPT_A DENY_A "Bash(rg:*)" "Bash(grep:*)" "Bash(cat:*)" "Bash(sed:*)" "Bash(head:*)" \
        "Bash(tail:*)" "Bash(wc:*)" "Bash(ls:*)" "Bash(find:*)" "Bash(sort:*)" "Bash(uniq:*)" \
        "Bash(cut:*)" "Bash(awk:*)" "Bash(comm:*)" Read Glob Grep; }

# ── ARM B: the real Seam ─────────────────────────────────────────────────────────────────────────────────
SKILL_MD="$ROOT/.claude/skills/seam/SKILL.md"
[ -f "$SKILL_MD" ] || { echo "ABORT: $SKILL_MD missing — arm B would run undocumented, the unfair run." >&2; exit 3; }
PROMPT_B="You are working in the repository at $REPO.

TASK: $TASK

You have the Seam CLI. Invoke it as:  bun $SEAM --repo $REPO [flags]
Its documentation follows; it is the same skill a Seam user has installed. Read it and use it — you should not
need to run --help.

===== BEGIN SEAM SKILL =====
$(cat "$SKILL_MD")
===== END SEAM SKILL =====

A scratch directory you may write to (identical for every arm): $OUT/.scratch-B
  — use it if you want to save output to a file rather than re-running a command.
$CONTRACT"
DENY_B=("${COMMON_DENY[@]}" "${NO_SEARCH[@]}" "Bash($HERE/call-flow:*)")
ARM_B () { run_arm B PROMPT_B DENY_B "Bash(bun:*)" "Bash(cat:*)" "Bash(sed:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(wc:*)" "Bash(ls:*)" \
        "Bash(find:*)" "Bash(sort:*)" "Bash(uniq:*)" "Bash(cut:*)" "Bash(awk:*)" "Bash(comm:*)" Read; }

# ── ARM C: the replay ceiling ────────────────────────────────────────────────────────────────────────────
# The doc is deliberately TINY. Arm B carries a 42 KB SKILL.md resident on every turn (+16.8k tokens of
# turn-one cache write, measured); if density is what costs, C is the arm where density is absent and the answers are still perfect.
PROMPT_C="You are working in the repository at $REPO.

TASK: $TASK

You have a flow-tracing tool. Invoke it as:  $HERE/call-flow --step N
Start at --step 1 and work through the steps IN ORDER (1, 2, 3, ...) until it prints DONE. Each step returns
structural facts about this flow. Do not skip steps.

A scratch directory you may write to (identical for every arm): $OUT/.scratch-C
  — use it if you want to save output to a file rather than re-running a command.
$CONTRACT"
DENY_C=("${COMMON_DENY[@]}" "${NO_SEARCH[@]}" "Bash(bun:*)")
ARM_C () { run_arm C PROMPT_C DENY_C "Bash($HERE/call-flow:*)" "Bash(cat:*)" "Bash(sed:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(wc:*)" "Bash(ls:*)" \
        "Bash(find:*)" "Bash(sort:*)" "Bash(uniq:*)" "Bash(cut:*)" "Bash(awk:*)" "Bash(comm:*)" Read; }

# ── ARM D: the replay ceiling PLUS grep ─────────────────────────────────────────────────────────────────
# Arm C is ideal for GETTING the answer and has no channel at all for CHECKING it: once the oracle prints DONE
# there is nothing left to ask, and every one of its 23 refusals across the published rounds is a grep. So its
# post-answer cost mixes two things — the urge to verify, and the price of verifying with only whole-file
# reads. Arm D separates them: the same oracle, the same manual, plus the search arm A has. It is also the
# honest ceiling for the COMPANION pitch (§6.2.4): a real user has the tool AND grep.
# Identical to C except that NO_SEARCH is not denied and the search verbs are granted.
PROMPT_D="You are working in the repository at $REPO.

TASK: $TASK

You have a flow-tracing tool. Invoke it as:  $HERE/call-flow --step N
Start at --step 1 and work through the steps IN ORDER (1, 2, 3, ...) until it prints DONE. Each step returns
structural facts about this flow. Do not skip steps.
ripgrep/grep and file reads are also available.

A scratch directory you may write to (identical for every arm): $OUT/.scratch-D
  — use it if you want to save output to a file rather than re-running a command.
$CONTRACT"
DENY_D=("${COMMON_DENY[@]}" "Bash(bun:*)")
ARM_D () { run_arm D PROMPT_D DENY_D "Bash($HERE/call-flow:*)" "Bash(rg:*)" "Bash(grep:*)" "Bash(cat:*)" "Bash(sed:*)" \
        "Bash(head:*)" "Bash(tail:*)" "Bash(wc:*)" "Bash(ls:*)" "Bash(find:*)" "Bash(sort:*)" "Bash(uniq:*)" \
        "Bash(cut:*)" "Bash(awk:*)" "Bash(comm:*)" Read Glob Grep; }

# ── RANDOMISED ARM ORDER ─────────────────────────────────────────────────────────────────────────────────
# bench/grep-vs-seam ran its arms in a FIXED order (grep first, always), which leaves an order confound
# nobody can rule out from the transcripts: API load, cache state and time of day all drift across a round,
# and they drift in the SAME direction relative to the arms every time. Shuffling costs nothing and closes
# the question. The realised order is recorded per round so a reader can check it, and re-check for an
# order effect after the fact.
# The repository commit is recorded per round: the published rounds did not record it, and it had to be
# reconstructed from the oracle's own line references (paper §6.1).
git -C "$REPO" rev-parse HEAD > "$OUT/$ROUND.repo" 2>/dev/null || echo "unknown" > "$OUT/$ROUND.repo"
ORDER=$(printf '%s\n' $(echo "$ARMS" | grep -o .) | shuf | tr -d '\n')
echo "$ORDER" > "$OUT/$ROUND.order"
echo "  arm order: $ORDER"
for a in $(echo "$ORDER" | grep -o .); do "ARM_$a"; done

echo "round done: $ROUND"
