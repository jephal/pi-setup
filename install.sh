#!/usr/bin/env bash
set -euo pipefail

# User-local Linux bootstrap for pi-setup. It never uses sudo or edits shell
# startup files. Re-run it safely after updating the package.
PI_SETUP_PACKAGE="git:github.com/jephal/pi-setup@main"
AST_GREP_PACKAGE="@ast-grep/cli@0.45.2"
LOCAL_BIN="${HOME}/.local/bin"
ENV_DIR="${HOME}/.config/pi-setup"
ENV_FILE="${ENV_DIR}/env"
NOTES_DIR="${NOTES_PATH:-${HOME}/notes}"

log() { printf '[pi-setup] %s\n' "$*"; }
warn() { printf '[pi-setup] warning: %s\n' "$*" >&2; }
fail() { printf '[pi-setup] error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required. Install curl with your Linux distribution package manager and rerun this script."

mkdir -p "$LOCAL_BIN" "$ENV_DIR" "$NOTES_DIR"

if command -v pi >/dev/null 2>&1; then
  PI_CMD="$(command -v pi)"
else
  log "Pi is not installed; using the official Pi installer."
  curl -fsSL https://pi.dev/install.sh | sh
  hash -r
  PI_CMD="$(command -v pi || true)"
  [ -n "$PI_CMD" ] || [ -x "$LOCAL_BIN/pi" ] || fail "Pi installation finished, but pi is not on PATH. Add ~/.local/bin to PATH and rerun."
  PI_CMD="${PI_CMD:-${LOCAL_BIN}/pi}"
fi

if command -v herdr >/dev/null 2>&1; then
  log "Herdr is already installed: $(command -v herdr)"
else
  log "Herdr is not installed; using the official Herdr installer."
  curl -fsSL https://herdr.dev/install.sh | HERDR_INSTALL_DIR="$LOCAL_BIN" sh
  hash -r
  [ -x "$LOCAL_BIN/herdr" ] || command -v herdr >/dev/null 2>&1 || fail "Herdr installation finished, but herdr is not on PATH. Add ~/.local/bin to PATH and rerun."
fi

if command -v ast-grep >/dev/null 2>&1; then
  log "ast-grep is already installed: $(command -v ast-grep)"
else
  command -v npm >/dev/null 2>&1 || fail "npm is required to install ast-grep. Install Node.js/npm and rerun this script."
  log "Installing ast-grep for Fovea."
  if ! npm install --global "$AST_GREP_PACKAGE"; then
    log "Global npm install is not writable; installing ast-grep under ~/.local instead."
    npm install --prefix "$HOME/.local" "$AST_GREP_PACKAGE"
  fi
  hash -r
  command -v ast-grep >/dev/null 2>&1 || warn "ast-grep installed but is not on PATH; add ~/.local/bin or your npm global bin directory."
fi

log "Installing or updating the pi-setup package."
"$PI_CMD" install "$PI_SETUP_PACKAGE"

if [ ! -e "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<EOF
# Environment for pi-setup. Source this file before starting Pi.
export PATH="${LOCAL_BIN}:\$PATH"
export NOTES_PATH="${NOTES_DIR}"
EOF
  chmod 600 "$ENV_FILE"
else
  warn "Keeping existing $ENV_FILE; it was not overwritten."
fi

printf '\n'
log "Setup complete."
printf '  Source configuration:  source %q\n' "$ENV_FILE"
printf '  Start Pi:              pi\n'
printf '  Notes directory:       %s\n' "$NOTES_DIR"
if command -v herdr >/dev/null 2>&1 || [ -x "$LOCAL_BIN/herdr" ]; then
  printf '  Herdr:                 installed\n'
else
  printf '  Herdr:                 not found on PATH\n'
fi
if command -v nvim >/dev/null 2>&1; then
  printf '  Neovim:                installed\n'
else
  printf '  Neovim:                optional; install it to use the notes viewer\n'
fi
printf '\nOptional Datadog setup:\n'
printf '  curl -sSL https://coterm.datadoghq.com/mcp-cli/install.sh | bash\n'
printf '  ~/.local/bin/datadog_mcp_cli --site us3 login\n'
