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
# ENFORCEMENT, not instruction. `--allowedTools` is applied by the runtime, so arm GREP cannot invoke seam even
# if it decides to. The prompt still says which tool to use, because an agent that is merely blocked will burn
# its budget rediscovering that — but the ALLOWLIST is what makes the result trustworthy, and `verify-arms.ts`
# re-checks the transcript afterwards rather than trusting either.
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

run_arm () {  # run_arm <letter> <allowed-tools...> ; prompt comes from $PROMPT
  local letter="$1"; shift
  local started ended
  started=$(date +%s)
  # stream-json keeps the full tool-call record, which is what verify-arms.ts audits for contamination and what
  # the tool-call count is taken from. `--max-turns` bounds a runaway loop without capping a legitimate one.
  claude -p "$PROMPT" \
    --output-format stream-json --verbose --max-turns 60 \
    --allowedTools "$@" \
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
$CONTRACT"
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
$CONTRACT"
run_arm B "Bash(bun:*)" Read

echo "done: $CASE"
