#!/usr/bin/env bash
# Seam installer — the `seam` CLI + Claude/Copilot skills + MCP server, from source via bun.
#
#   curl -fsSL https://raw.githubusercontent.com/Scorbutics/seam/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --skill        # only the `seam` CLI + the skills
#   curl -fsSL .../install.sh | bash -s -- --mcp          # only the MCP server (Claude; not Copilot)
#   curl -fsSL .../install.sh | bash -s -- --skill --mcp  # both (also the default)
#   curl -fsSL .../install.sh | bash -s -- --copilot-mcp  # ALSO register the MCP with Copilot (off by default)
#
# Installs from SOURCE (one git checkout + `bun install`), not a prebuilt binary, so it keeps
# full tree-sitter facts for all languages and updates with a re-run. The skills and the MCP server
# both reach the same stateless engine; nothing runs as a daemon. The Copilot skill drives the `seam`
# CLI (Copilot is unreliable with MCP), so Copilot MCP registration is OFF by default (--copilot-mcp to opt in).
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
do_skill=0; do_mcp=0; do_copilot_mcp=0
for a in "$@"; do
  case "$a" in
    --skill) do_skill=1 ;;
    --mcp)   do_mcp=1 ;;
    --copilot-mcp) do_copilot_mcp=1 ;;   # opt back IN to registering the seam MCP with Copilot (off by default — Copilot is unreliable with MCP; its skill drives the CLI)
    -h|--help)
      sed -n '2,18p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown argument: $a (expected --skill, --mcp, and/or --copilot-mcp)" ;;
  esac
done
# default (no host flag at all): install both the skills and the MCP
if [ "$do_skill" -eq 0 ] && [ "$do_mcp" -eq 0 ] && [ "$do_copilot_mcp" -eq 0 ]; then do_skill=1; do_mcp=1; fi
# --copilot-mcp opts INTO the Copilot registration, which lives inside the --mcp block, so it needs it on
[ "$do_copilot_mcp" -eq 1 ] && do_mcp=1

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

# Convenience CLI shims: `seam` (the engine) + `seam-adapters` (list/promote learned .seam adapters).
# These are the recommended way to drive Seam — the CLI has no MCP round-trip / host request-deadline.
mkdir -p "$HOME/.local/bin" 2>/dev/null || true
if [ -d "$HOME/.local/bin" ]; then
  seam_shim="$HOME/.local/bin/seam"
  printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' "$BUN" "$HOME_DIR/ts/src/cli/decompose.ts" > "$seam_shim" && chmod +x "$seam_shim"
  adapters_shim="$HOME/.local/bin/seam-adapters"
  printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' "$BUN" "$HOME_DIR/ts/src/cli/adapters.ts" > "$adapters_shim" && chmod +x "$adapters_shim"
  log "installed CLI → $seam_shim  (+ seam-adapters)"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) warn "  → ~/.local/bin is not on PATH. Add it so 'seam' works everywhere:  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
else
  log "seam: run via  $BUN $HOME_DIR/ts/src/cli/decompose.ts   (couldn't create ~/.local/bin for a 'seam' shim)"
fi

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
  log "Claude Code skill installed — ask to \"run Seam\" / \"decompose this diff\" / \"map the footprint of X\"."

  # Copilot CLI reads personal skills from ~/.copilot/skills (NOT ~/.claude/skills). Copilot is unreliable
  # with MCP servers (request timeouts, dropped tool-call namespaces), so its skill drives the `seam` CLI
  # directly — not the MCP. Pin the engine command (in case `seam` isn't on PATH). Only when copilot is on
  # PATH (else it's litter).
  if command -v copilot >/dev/null 2>&1; then
    cop_skill="$HOME_DIR/copilot-skill/SKILL.md"
    if [ -f "$cop_skill" ]; then
      mkdir -p "$HOME/.copilot/skills/seam"
      awk -v cli="bun $HOME_DIR/ts/src/cli/decompose.ts" '
        /^---$/ { c++; print
          if (c == 2) {
            print ""
            print "> **Installed by install.sh.** If the `seam` command is not on PATH, run the engine as"
            print "> `" cli "` — substitute it wherever this skill writes `seam`."
          }
          next
        }
        { print }
      ' "$cop_skill" > "$HOME/.copilot/skills/seam/SKILL.md"
      log "Copilot CLI skill installed → ~/.copilot/skills/seam/ (drives the seam CLI, not MCP)."
    fi
  fi
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

  # GitHub Copilot CLI — registration is OFF BY DEFAULT. Copilot is unreliable with MCP servers (request
  # timeouts, dropped tool-call namespaces), and its skill now drives the `seam` CLI directly, so the MCP
  # is redundant there. Opt back in with --copilot-mcp. (When on: Copilot has NO MCP sampling, so
  # SEAM_MCP_LLM=binary serves the engine's LLM passes via the local copilot binary. </dev/null stops a
  # not-yet-installed copilot stub from hanging the script.)
  if command -v copilot >/dev/null 2>&1; then
    if [ "$do_copilot_mcp" -eq 1 ]; then
      log "registering 'seam' with GitHub Copilot CLI (--copilot-mcp)"
      copilot mcp remove seam </dev/null >/dev/null 2>&1 || true
      copilot mcp add seam --env SEAM_MCP_LLM=binary -- "$BUN" "$server" </dev/null >/dev/null 2>&1 || true
      if has_seam "$HOME/.copilot/mcp-config.json"; then
        registered=1; log "  → Copilot CLI: registered (~/.copilot/mcp-config.json; LLM passes via the copilot binary)."
      else
        warn "  → Copilot CLI on PATH but registration didn't take (likely the install stub, or it needs auth). Run it yourself:"
        warn "      copilot mcp add seam --env SEAM_MCP_LLM=binary -- $BUN $server"
      fi
    else
      log "Copilot CLI: skipping MCP registration (use the CLI skill instead; --copilot-mcp to register anyway)."
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
