#!/usr/bin/env bash
# LAUNCH BOTH ARMS of the agent A/B, under ENFORCED tool restrictions.
#
#   bench/grep-vs-seam/run-arms.sh <case-id> <repo> "<task>"
#
# WHY THIS EXISTS AS A SCRIPT. Runs 1-4 were launched by hand, and the bias control broke TWICE that way — most
# recently arm GREP inherited MCP servers and could reach Seam tools, which silently turned the control arm into
# a second treatment arm. A hand-typed protocol is not a protocol. Everything that must be identical between the
# arms (task, repo, output contract, turn budget) is set ONCE here; everything that must differ (the toolset) is
# the only forked line.
#
# ENFORCEMENT — and `--allowedTools` ALONE DOES NOT PROVIDE IT. Measured 2026-07-31 on the cal-booking-flow run:
# arm SEAM was launched with `--allowedTools "Bash(bun:*)" Read` and still ran
# `grep -rl "handleNewBooking" <dir> --include=*.ts`. Allow-listing one Bash pattern evidently permits Bash
# generally, so the allowlist is advisory for the shell. That run was discarded.
#
# So the split is enforced THREE ways, because the first one demonstrably failed and the control has now broken
# three times in this benchmark's history:
#   1. --allowedTools      — what the arm should reach for (ADVISORY: does not gate sub-commands inside Bash)
#   2. --disallowedTools   — likewise ADVISORY. Measured: arm SEAM ran `grep -rl ...` FIVE times with
#                            `--disallowedTools "Bash(grep:*)"` set. Neither flag gates the shell.
#   3. verify-arms.ts      — reads the transcript afterwards and exits non-zero on what actually happened.
#
# A PATH SHIM was tried and REMOVED. It stubbed `grep`/`rg`/... to exit 127, which worked — and then cost the
# arm calls DISCOVERING it: `which rg`, probe commands, and python3 heredocs written to read files the shimmed
# verb would have read. Arm SEAM had 6 shimmed verbs to arm GREP's 3, so the apparatus charged the treatment
# arm more than the control for a restriction neither tool imposes. --disallowedTools was separately verified
# to block (cal-ab2: 6 grep attempts, 6 denied, 0 succeeded), so the shim was redundant cost.
#
# THE ARMS ARE NAMED .A / .B ON DISK ON PURPOSE. The subagent writes its own answer, and a file called
# `.seam.md` would tell it the run is about Seam and invite it to try harder. Readable names are applied at
# SCORING time, where no agent can see them.
set -u
CASE="${1:?usage: run-arms.sh <case-id> <repo> \"<task>\"}"
REPO="${2:?repo}"
TASK="${3:?task}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/results"
SEAM="$(cd "$HERE/../.." && pwd)/ts/src/cli/decompose.ts"
mkdir -p "$OUT"

# THE OUTPUT CONTRACT — identical for both arms, and the reason precision is measurable at all. score.ts has
# twice been patched for accidentally scoring PROSE STYLE (run 4: identical knowledge scored 35% vs 85% because
# one arm wrote `Foo.tsx` and the other wrote `Foo,` in a list). Free text cannot be scored for precision
# without reintroducing that. So both arms must end with a machine-readable block, and both are told the same
# thing about it, in the same words.
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

# ── MEASUREMENT HYGIENE: an isolated, PRE-WARMED cache ───────────────────────────────────────────────────────
# Two confounds cost most of a day (2026-08-02/03) and both are apparatus, not tool:
#
#   1. SHARED CACHE. Every shard lives under the analysed repo (`<repo>/.seam`), so any concurrent profiling
#      run contends with the benchmark — and clearing a cache for one silently re-times the other. That
#      happened mid-flight: deleting `grow-v1` invalidated two of three runs. A git worktree does NOT help;
#      it isolates the code, not the repo under test. `SEAM_REPO_CACHE_DIR` gives this benchmark its own root.
#
#   2. COLD-AFTER-REBUILD. The cache is keyed on the core's build stamp, so the FIRST run after any
#      `cargo build` pays a full floor + footprint rebuild. Measured on one unchanged command: 15s, 34s, 49s,
#      52s, 115s — nearly all of that spread was first-after-build, not the engine.
#
# So: one cache root for the whole case, warmed by a DISCARDED grow before either arm starts. That is also the
# honest model of a real user, whose repo cache is warm — a per-run cold cache would charge arm SEAM for
# first-run cost that no real invocation pays, which is the mirror image of the bias this harness exists to
# avoid.
export SEAM_REPO_CACHE_DIR="${SEAM_REPO_CACHE_DIR:-/tmp/seam-bench-cache}"
mkdir -p "$SEAM_REPO_CACHE_DIR"
echo "  cache root: $SEAM_REPO_CACHE_DIR (isolated)"
# WARMED BY REPLAY, not by a hand-picked anchor. kc12 pre-warmed ONE anchor into a fresh root and arm SEAM's
# engine time came out 111.6/120.9/32.7s against 20.4/22.6/62.7s on a shared warm cache — the isolation had
# stripped the legitimate warmth along with the contamination, charging the treatment arm for cold-path work
# no real invocation pays. `prewarm.sh` replays the Seam commands PREVIOUS runs actually issued, so the cache
# holds what an agent reaches for on this case rather than what the harness author guessed.
if [ -n "$(ls "$OUT"/*.B.jsonl 2>/dev/null | head -1)" ]; then
  "$HERE/prewarm.sh" "$REPO" $(ls -t "$OUT"/*.B.jsonl 2>/dev/null | head -6) || true
else
  echo "  pre-warm: no prior transcripts to replay — first run on this case will be COLD, and its arm-SEAM"
  echo "            engine time is not comparable to a warmed one. Discard it or re-run."
fi

run_arm () {  # run_arm <letter> <allowed-tools...> ; prompt comes from $PROMPT
  local letter="$1"; shift
  local started ended
  started=$(date +%s)
  # stream-json keeps the full tool-call record, which is what verify-arms.ts audits for contamination and what
  # the tool-call count is taken from. `--max-turns` bounds a runaway loop without capping a legitimate one.
  local -n deny="DENY_$letter"
  # A WRITABLE SCRATCH DIR, because its absence was being measured as a tool cost.
  #
  # Measured 2026-07-31 (cal-ab5): FOUR of arm SEAM's 32 calls were sandbox refusals, not Seam failures —
  # "Output redirection to '/tmp/seamrun_out.txt' was blocked", "Redirect target contains $(cmd) output",
  # "This Bash command contains multiple operations ... require approval". The agent was trying to spool a
  # large answer to a file so it could page through it.
  #
  # That penalty falls on ONE ARM. Seam emits large structured answers an agent naturally saves; the grep arm
  # pipes to `head` and never needs a file. Leaving it in place means the harness charges the treatment arm for
  # a restriction the control arm cannot trigger — a bias in the apparatus, not a property of either tool.
  local scratch="$OUT/.scratch-$letter"
  rm -rf "$scratch"; mkdir -p "$scratch"
  claude -p "$PROMPT" \
    --output-format stream-json --verbose --max-turns 60 \
    --add-dir "$scratch" \
    --allowedTools "$@" --disallowedTools "${deny[@]}" \
    > "$OUT/$CASE.$letter.jsonl" 2>"$OUT/$CASE.$letter.stderr"
  ended=$(date +%s)
  echo "$((ended - started))" > "$OUT/$CASE.$letter.secs"
  echo "  arm $letter: $((ended - started))s  -> $OUT/$CASE.$letter.jsonl"
}

# ── ARM B: seam only ─────────────────────────────────────────────────────────────────────────────────────────
# `Bash(bun:*)` is the narrowest workable grant: the CLI is invoked through bun. It does technically permit other
# bun scripts, which is why verify-arms.ts audits the transcript for rg/grep use rather than trusting this line.
# Read is granted to BOTH arms — reading a file it was pointed at is not the capability under test.
# THE SKILL IS THE PRODUCT SURFACE, and the first run of this harness omitted it — arm SEAM was told to run
# `--help` and work the CLI out, while arm GREP used a tool it already knew. That is not a fair comparison: it
# measured an agent DISCOVERING an undocumented CLI. `install.sh --skill` puts SKILL.md in ~/.claude/skills/seam
# for every real user, so the benchmark must hand arm SEAM the same thing. Injected inline rather than relying
# on skill auto-discovery, so the arm cannot silently run without it and quietly become the unfair run again.
SKILL_MD="$(cd "$HERE/../.." && pwd)/.claude/skills/seam/SKILL.md"
[ -f "$SKILL_MD" ] || { echo "ABORT: $SKILL_MD missing — arm SEAM would run undocumented, which is the unfair run." >&2; exit 3; }
PROMPT="You are working in the repository at $REPO.

TASK: $TASK

You have the Seam CLI. Invoke it as:  bun $SEAM --repo $REPO [flags]
Its documentation follows; it is the same skill a Seam user has installed. Read it and use it — you should not
need to run --help.

===== BEGIN SEAM SKILL =====
$(cat "$SKILL_MD")
===== END SEAM SKILL =====

A scratch directory you may write to (identical for both arms): $OUT/.scratch-B
  — use it if you want to save output to a file rather than re-running a command.
$CONTRACT"
DENY_B=("Bash(grep:*)" "Bash(rg:*)" "Bash(egrep:*)" "Bash(fgrep:*)" "Bash(ag:*)" "Bash(ack:*)" Grep Glob "Bash(sleep:*)" Agent Task TaskCreate TaskUpdate TaskList TaskGet TaskOutput TaskStop ScheduleWakeup ToolSearch CronCreate WebSearch WebFetch)
run_arm B "Bash(bun:*)" Read

echo "done: $CASE"
