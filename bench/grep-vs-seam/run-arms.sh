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
#   3. a PATH SHIM         — the layer that actually blocks. The arm runs with a directory of stub binaries
#                            first on PATH, so `grep`/`rg`/... exit non-zero with an explanation.
#   4. verify-arms.ts      — reads the transcript afterwards. An absolute path (/usr/bin/grep) still defeats
#                            the shim, so the audit remains the backstop and still exits non-zero.
# Three of these are claims about what COULD happen; only (4) reports what DID, which is why it stays.
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

# Build a directory of refusing stubs for the verbs this arm must not use, and put it FIRST on PATH.
make_shim () {  # make_shim <dir> <verb...>
  local dir="$1"; shift
  mkdir -p "$dir"
  for verb in "$@"; do
    printf '#!/bin/sh\necho "%s is not available to this benchmark arm (see bench/grep-vs-seam/run-arms.sh)" >&2\nexit 127\n' "$verb" > "$dir/$verb"
    chmod +x "$dir/$verb"
  done
}

run_arm () {  # run_arm <letter> <allowed-tools...> ; prompt comes from $PROMPT
  local letter="$1"; shift
  local started ended
  started=$(date +%s)
  # stream-json keeps the full tool-call record, which is what verify-arms.ts audits for contamination and what
  # the tool-call count is taken from. `--max-turns` bounds a runaway loop without capping a legitimate one.
  local -n deny="DENY_$letter"
  local -n shimverbs="SHIM_$letter"
  local shim="$OUT/.shim-$letter"
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
  rm -rf "$shim"; make_shim "$shim" "${shimverbs[@]}"
  # The shim goes FIRST on PATH — this is the layer that actually blocks, since the tool flags do not gate
  # sub-commands inside Bash. An absolute path still defeats it, which is why verify-arms.ts stays.
  PATH="$shim:$PATH" claude -p "$PROMPT" \
    --output-format stream-json --verbose --max-turns 60 \
    --add-dir "$scratch" \
    --allowedTools "$@" --disallowedTools "${deny[@]}" \
    > "$OUT/$CASE.$letter.jsonl" 2>"$OUT/$CASE.$letter.stderr"
  ended=$(date +%s)
  echo "$((ended - started))" > "$OUT/$CASE.$letter.secs"
  echo "  arm $letter: $((ended - started))s  -> $OUT/$CASE.$letter.jsonl"
}

# ── ARM A: grep only ─────────────────────────────────────────────────────────────────────────────────────────
# Read-only shell verbs plus the native search tools. Seam is absent from the allowlist, so it is unreachable.
PROMPT="You are working in the repository at $REPO.

TASK: $TASK

Use ripgrep/grep and file reads to answer. Work from the repo root: $REPO

A scratch directory you may write to (identical for both arms): $OUT/.scratch-A
  — use it if you want to save output to a file rather than re-running a command.
$CONTRACT"
DENY_A=("Bash(bun:*)" "Bash(node:*)" "Bash(npx:*)")          # no Seam, by any launcher
SHIM_A=(bun node npx)
run_arm A "Bash(rg:*)" "Bash(grep:*)" "Bash(cat:*)" "Bash(sed:*)" "Bash(head:*)" "Bash(tail:*)" \
          "Bash(wc:*)" "Bash(ls:*)" "Bash(find:*)" "Bash(sort:*)" "Bash(uniq:*)" "Bash(cut:*)" \
          "Bash(awk:*)" "Bash(comm:*)" Read Glob Grep

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
DENY_B=("Bash(grep:*)" "Bash(rg:*)" "Bash(egrep:*)" "Bash(fgrep:*)" "Bash(ag:*)" "Bash(ack:*)" Grep Glob)
# NOT `bun`: arm SEAM invokes the CLI through it. Only the SEARCH verbs are shimmed away.
SHIM_B=(grep rg egrep fgrep ag ack)
run_arm B "Bash(bun:*)" Read

echo "done: $CASE"
