#!/usr/bin/env bash
# Seam installer — the `seam` CLI + the Claude/Copilot skills, from source via bun.
#
#   curl -fsSL https://raw.githubusercontent.com/Scorbutics/seam/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --branch <ref> # install/track a specific branch or tag (else: main)
#
# Installs from SOURCE (one git checkout + `bun install`), not a prebuilt binary, so it keeps
# full tree-sitter facts for all languages and updates with a re-run. The skills drive the `seam` CLI
# against a stateless engine; nothing runs as a daemon.
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
do_skill=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skill) do_skill=1 ;;
    --branch|--ref) shift; [ "$#" -gt 0 ] || die "--branch needs a value (a branch or tag)"; REF="$1" ;;   # install/track a specific branch or tag (same as SEAM_REF=)
    --branch=*|--ref=*) REF="${1#*=}" ;;
    -h|--help)
      sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown argument: $1 (expected --skill and/or --branch <ref>)" ;;
  esac
  shift
done

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

# ── the NATIVE CORE ─────────────────────────────────────────────────────────--
# WITHOUT THIS THE INSTALL IS BROKEN, and it was: this script cloned, ran `bun install`, and stopped. There is no
# TypeScript engine to fall back to (rust_core.ts says so in as many words), so every codebase query died with a
# raw `Cannot find module '.../rust/seam_core.node'` -- a module-resolution stack trace as the first thing a new
# user saw. Verified by pointing SEAM_RUST_CORE_PATH at a missing file, which is exactly the fresh-install state.
CORE="$HOME_DIR/rust/seam_core.node"
if [ ! -f "$CORE" ]; then
  uname_s="$(uname -s)"; uname_m="$(uname -m)"
  case "$uname_s-$uname_m" in
    Linux-x86_64)  asset="seam_core-linux-x64.node" ;;
    Linux-aarch64) asset="seam_core-linux-arm64.node" ;;
    Darwin-arm64)  asset="seam_core-darwin-arm64.node" ;;
    Darwin-x86_64) asset="seam_core-darwin-x64.node" ;;
    *)             asset="" ;;
  esac
  if [ -n "$asset" ]; then
    log "fetching prebuilt native core ($asset)"
    curl -fsSL -o "$CORE" "https://github.com/Scorbutics/seam/releases/latest/download/$asset" 2>/dev/null || rm -f "$CORE"
  fi
fi
if [ ! -f "$CORE" ] && command -v cargo >/dev/null 2>&1; then
  log "building native core from source (cargo; the first build takes a few minutes)"
  if ( cd "$HOME_DIR/rust" && cargo build --release -p seam-napi ); then
    for ext in so dylib dll; do
      [ -f "$HOME_DIR/rust/target/release/libseam_napi.$ext" ] && cp "$HOME_DIR/rust/target/release/libseam_napi.$ext" "$CORE" && break
    done
  fi
fi

# THE HEALTH CHECK IS NOW LOAD-BEARING. It used to run and throw its result away (`if ...; then :; fi`) -- a
# check whose outcome is discarded is not a check, and it is why a broken install reported success.
if [ ! -f "$CORE" ]; then
  warn "native core MISSING -- the codebase queries will NOT run."
  warn "  Install a Rust toolchain (https://rustup.rs) and re-run this script, or build it yourself:"
  warn "    cd $HOME_DIR/rust && cargo build --release -p seam-napi && cp target/release/libseam_napi.* seam_core.node"
elif "$BUN" "$HOME_DIR/ts/src/cli/decompose.ts" --locate seam --repo "$HOME_DIR" >/dev/null 2>&1; then
  log "native core OK ($CORE)"
else
  warn "native core present but the engine did not answer. Please report, with the output of:"
  warn "    $BUN $HOME_DIR/ts/src/cli/decompose.ts --locate seam --repo $HOME_DIR"
fi
log "engine ready: $BUN $HOME_DIR/ts/src/cli/decompose.ts"

# Convenience CLI shims: `seam` (the engine) + `seam-adapters` (list/promote learned .seam adapters).
# These are how Seam is driven: a skill invoking the CLI against a stateless engine.
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
  # The skill drives the `seam` CLI directly. Pin the engine command (in case `seam` isn't on PATH). Only when copilot is on
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
      log "Copilot CLI skill installed → ~/.copilot/skills/seam/ (drives the seam CLI)."
    fi
  fi
fi

log "done. Re-run this script any time to update (it tracks $REF). Checkout: $HOME_DIR"
