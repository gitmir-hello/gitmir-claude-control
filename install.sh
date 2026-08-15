#!/usr/bin/env bash
# GITMIR Claude Control — install in one line.
#
#   curl -fsSL https://raw.githubusercontent.com/gitmir-hello/gitmir-claude-control/main/install.sh | bash
#
# It clones the repository into ~/.gitmir/claude-control and links a `gitmir`
# command onto your PATH. Nothing is compiled and nothing is downloaded from a
# package registry: Node runs the TypeScript directly, the diagram renderer is
# written for this project, and the fonts are in the repository.
#
# Run it again to update — it pulls instead of re-cloning.
#
# Reading this before running it is the correct instinct, and this file is short
# on purpose. Everything it touches:
#   ~/.gitmir/claude-control   the checkout
#   ~/.local/bin/gitmir        a symlink to bin/gitmir inside that checkout

set -euo pipefail

REPO="${GITMIR_REPO:-https://github.com/gitmir-hello/gitmir-claude-control.git}"
BRANCH="${GITMIR_BRANCH:-main}"
DIR="${GITMIR_HOME:-$HOME/.gitmir/claude-control}"

c()   { printf '\033[%sm%s\033[0m' "$1" "$2"; }
say()  { printf '  %s\n' "$*"; }
step() { printf '  %s %s\n' "$(c '0;36' '·')" "$*"; }
die()  { printf '\n  %s %s\n\n' "$(c '1;31' '✕')" "$*" >&2; exit 1; }

printf '\n  %s\n\n' "$(c '1;36' 'GITMIR Claude Control')"

# --- node ---------------------------------------------------------------------
# The one hard requirement, and the one that fails confusingly if unmet: below
# 22.18 Node cannot strip TypeScript types, so the server dies on a type
# annotation rather than saying what is wrong.
command -v node >/dev/null 2>&1 || die "Node.js is not installed.
    Get it from https://nodejs.org — version 22.18 or newer.
    (macOS with Homebrew: brew install node)"

NODEV="$(node -v | sed 's/^v//')"
MAJ="${NODEV%%.*}"; MIN="$(printf '%s' "$NODEV" | cut -d. -f2)"
if [ "$MAJ" -lt 22 ] || { [ "$MAJ" -eq 22 ] && [ "$MIN" -lt 18 ]; }; then
  die "Node $NODEV is too old.
    This runs TypeScript with no build step, which Node can do from 22.18.
    Node 18 and 20 are both past end of life."
fi
step "Node $NODEV"

# --- fetch --------------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  step "Updating $DIR"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH"
  # Hard reset, not merge: this is an install script, and a half-merged checkout
  # is a worse outcome than losing a local edit nobody meant to make here.
  git -C "$DIR" reset --quiet --hard "origin/$BRANCH"
elif command -v git >/dev/null 2>&1; then
  step "Cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
else
  # No git: take the tarball. `gitmir update` will say to re-run this script.
  step "No git — downloading a snapshot into $DIR"
  command -v tar >/dev/null 2>&1 || die "Neither git nor tar is available. Install one of them."
  TAR="${REPO%.git}/archive/refs/heads/$BRANCH.tar.gz"
  TMP="$(mktemp -d)"
  curl -fsSL "$TAR" -o "$TMP/src.tgz" || die "Could not download $TAR"
  mkdir -p "$DIR"
  tar -xzf "$TMP/src.tgz" -C "$DIR" --strip-components=1
  rm -rf "$TMP"
fi

chmod +x "$DIR/bin/gitmir" 2>/dev/null || true

# --- the command ---------------------------------------------------------------
# A symlink rather than a copy, so `gitmir update` updates the launcher too.
BIN="${GITMIR_BIN:-$HOME/.local/bin}"
mkdir -p "$BIN"
ln -sf "$DIR/bin/gitmir" "$BIN/gitmir"
step "Linked $BIN/gitmir"

ON_PATH=0
case ":$PATH:" in *":$BIN:"*) ON_PATH=1 ;; esac

# --- what to do next -----------------------------------------------------------
printf '\n  %s\n\n' "$(c '1;32' 'Installed.')"

if [ "$ON_PATH" -eq 0 ]; then
  RC="$HOME/.bashrc"
  case "${SHELL:-}" in */zsh) RC="$HOME/.zshrc" ;; esac
  printf '  %s %s is not on your PATH. Add it:\n\n' "$(c '1;33' '!')" "$BIN"
  printf '      echo '"'"'export PATH="%s:$PATH"'"'"' >> %s\n' "$BIN" "$RC"
  printf '      source %s\n\n' "$RC"
  printf '  Or start it right now with the full path:\n\n'
  printf '      %s\n\n' "$(c '0;36' "$BIN/gitmir")"
else
  printf '      %s              start it and open the browser\n' "$(c '0;36' 'gitmir')"
  printf '      %s     let your agent use the same model\n' "$(c '0;36' 'gitmir mcp add')"
  printf '      %s       node, port, version, what is missing\n' "$(c '0;36' 'gitmir status')"
  printf '      %s       pull the latest\n\n' "$(c '0;36' 'gitmir update')"
fi

say "The dashboard needs the $(c '1;37' 'claude') CLI on your PATH to run Claude for you."
say "Nothing is uploaded anywhere and there is no telemetry — see SECURITY.md."
printf '\n'
