#!/usr/bin/env bash
# Seam installer — Claude Code skill + MCP server, from source via bun.
#
#   curl -fsSL https://raw.githubusercontent.com/Scorbutics/seam/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --skill   # only the Claude Code skill
#   curl -fsSL .../install.sh | bash -s -- --mcp      # only the MCP server
#   curl -fsSL .../install.sh | bash -s -- --skill --mcp   # both (also the default)
#
# Installs from SOURCE (one git checkout + `bun install`), not a prebuilt binary, so it keeps
# full tree-sitter facts for all languages and updates with a re-run. The skill and the MCP server
# both reach the same stateless engine; nothing runs as a daemon.
#
# Env overrides:
#   SEAM_HOME   checkout dir            (default: ~/.seam)
#   SEAM_REPO   git remote              (default: https://github.com/Scorbutics/seam.git)
#   SEAM_REF    branch or tag to track  (default: main)
set -euo pipefail

REPO="${SEAM_REPO:-https://github.com/Scorbutics/seam.git}"
REF="${SEAM_REF:-main}"
HOME_DIR="${SEAM_HOME:-$HOME/.seam}"
SKILL_DIR="$HOME/.claude/skills/seam"

c_info=$'\033[1;36m'; c_warn=$'\033[1;33m'; c_err=$'\033[1;31m'; c_off=$'\033[0m'
log()  { printf '%s[seam]%s %s\n' "$c_info" "$c_off" "$*"; }
warn() { printf '%s[seam]%s %s\n' "$c_warn" "$c_off" "$*" >&2; }
die()  { printf '%s[seam]%s %s\n' "$c_err"  "$c_off" "$*" >&2; exit 1; }

# ── flags ─────────────────────────────────────────────────────────────────────
do_skill=0; do_mcp=0
for a in "$@"; do
  case "$a" in
    --skill) do_skill=1 ;;
    --mcp)   do_mcp=1 ;;
    -h|--help)
      sed -n '2,18p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown argument: $a (expected --skill and/or --mcp)" ;;
  esac
done
# default: install both
if [ "$do_skill" -eq 0 ] && [ "$do_mcp" -eq 0 ]; then do_skill=1; do_mcp=1; fi

# ── prerequisites ───────────────────────────────────────────────────────────--
command -v git  >/dev/null 2>&1 || die "git is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)"; return; fi
  if [ -x "$HOME/.bun/bin/bun" ]; then BUN="$HOME/.bun/bin/bun"; return; fi
  log "bun not found — installing it (https://bun.sh)…"
  curl -fsSL https://bun.sh/install | bash
  [ -x "$HOME/.bun/bin/bun" ] || die "bun install failed; install bun manually then re-run"
  BUN="$HOME/.bun/bin/bun"
}
ensure_bun
log "using bun: $BUN"

# ── fetch / update the checkout ────────────────────────────────────────────--─
if [ -d "$HOME_DIR/.git" ]; then
  log "updating Seam in $HOME_DIR (ref: $REF)"
  git -C "$HOME_DIR" fetch --depth 1 origin "$REF"
  git -C "$HOME_DIR" checkout -q --detach FETCH_HEAD
else
  log "cloning Seam into $HOME_DIR (ref: $REF)"
  git clone --depth 1 --branch "$REF" "$REPO" "$HOME_DIR"
fi

# ── install engine deps ─────────────────────────────────────────────────────--
log "installing engine deps (ts/) — this pulls tree-sitter grammars"
( cd "$HOME_DIR/ts" && { "$BUN" install --frozen-lockfile || "$BUN" install; } )
if [ "$do_mcp" -eq 1 ]; then
  log "installing MCP server deps (mcp/)"
  ( cd "$HOME_DIR/mcp" && { "$BUN" install --frozen-lockfile || "$BUN" install; } )
fi

# does the engine even load?
if "$BUN" "$HOME_DIR/ts/src/cli/decompose.ts" --check-backend >/dev/null 2>&1; then :; fi
log "engine ready: $BUN $HOME_DIR/ts/src/cli/decompose.ts"

# ── skill (Claude Code) ────────────────────────────────────────────────────--─
if [ "$do_skill" -eq 1 ]; then
  src_skill="$HOME_DIR/.claude/skills/seam/SKILL.md"
  [ -f "$src_skill" ] || die "skill source missing at $src_skill"
  log "installing Claude Code skill → $SKILL_DIR"
  mkdir -p "$SKILL_DIR"
  # Pin the checkout path. The skill normally defaults SEAM to "this repo"; installed standalone it
  # must point at the checkout so it works from ANY project. Inject the pin right after the YAML
  # frontmatter (after the 2nd `---`) — robust to the skill's prose changing.
  awk -v home="$HOME_DIR" '
    /^---$/ { c++; print
      if (c == 2) {
        print ""
        print "> **Installed standalone by install.sh.** The Seam engine checkout is at `" home "`."
        print "> Set `SEAM=" home "` and `ENGINE=\"bun $SEAM/ts/src/cli/decompose.ts\"`."
        print "> Do NOT search the current project for a checkout."
      }
      next
    }
    { print }
  ' "$src_skill" > "$SKILL_DIR/SKILL.md"
  log "skill installed — in Claude Code, ask to \"run Seam\" / \"decompose this diff\" / \"map the footprint of X\"."
fi

# ── MCP server ─────────────────────────────────────────────────────────────--─
if [ "$do_mcp" -eq 1 ]; then
  server="$HOME_DIR/mcp/src/server.ts"
  [ -f "$server" ] || die "MCP server missing at $server"
  registered=0

  # We confirm each registration by grepping the host's config rather than trusting the exit code —
  # an uninstalled `copilot` stub prints "Install Copilot CLI?" and exits 0 without registering anything.
  has_seam() { grep -q '"seam"' "$1" 2>/dev/null; }

  # Claude Code — supports MCP sampling, but a local `claude` binary also serves LLM passes; `auto`
  # (the server default) prefers the binary, so no SEAM_MCP_LLM needed here.
  if command -v claude >/dev/null 2>&1; then
    log "registering 'seam' with Claude Code (user scope)"
    claude mcp remove seam -s user >/dev/null 2>&1 || true
    claude mcp add seam -s user -- "$BUN" "$server" </dev/null >/dev/null 2>&1 || true
    if has_seam "$HOME/.claude.json"; then
      registered=1; log "  → Claude Code: registered (restart it to pick up the server)."
    else
      warn "  → Claude Code: registration didn't take; register manually (see below)."
    fi
  fi

  # GitHub Copilot CLI — same `mcp add` shape, but Copilot has NO MCP sampling, so the engine's LLM
  # passes (hybrid/llm/grow) must come from a local binary. With copilot on PATH, SEAM_MCP_LLM=binary
  # makes the server serve them via the copilot binary itself. </dev/null stops a not-yet-installed
  # copilot stub (which prompts to install) from hanging the script — it EOFs and writes no config.
  if command -v copilot >/dev/null 2>&1; then
    log "registering 'seam' with GitHub Copilot CLI"
    copilot mcp remove seam </dev/null >/dev/null 2>&1 || true
    copilot mcp add seam --env SEAM_MCP_LLM=binary -- "$BUN" "$server" </dev/null >/dev/null 2>&1 || true
    if has_seam "$HOME/.copilot/mcp-config.json"; then
      registered=1; log "  → Copilot CLI: registered (~/.copilot/mcp-config.json; LLM passes via the copilot binary)."
    else
      warn "  → Copilot CLI on PATH but registration didn't take (likely the install stub, or it needs auth). Run it yourself:"
      warn "      copilot mcp add seam --env SEAM_MCP_LLM=binary -- $BUN $server"
    fi
  fi

  if [ "$registered" -eq 0 ]; then
    warn "no MCP host auto-registered. Add Seam as a stdio server to your host:"
    warn "    Copilot CLI:  copilot mcp add seam --env SEAM_MCP_LLM=binary -- $BUN $server"
    warn "    Claude Code:  claude  mcp add seam -s user -- $BUN $server"
    warn "    (raw stdio)   command: $BUN   args: $server"
    warn "  SEAM_MCP_LLM controls LLM passes: binary (local claude/copilot) | sampling (caller's model) | auto."
  fi
fi

log "done. Re-run this script any time to update (it tracks $REF). Checkout: $HOME_DIR"
