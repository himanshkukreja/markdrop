¸¸ǥit#!/usr/bin/env sh
# markdrop installer — Linux & macOS
#
# One-liner (once hosted at markdrop.in/install.sh):
#   curl -fsSL https://markdrop.in/install.sh | sh
#
# For Ubuntu/Debian users who prefer "sudo apt install markdrop", use the
# APT repo setup instead — see https://markdrop.in or the README.
#
# This script installs the binary directly to /usr/local/bin (or ~/bin if no
# write permission). No package manager or root required when using ~/bin.

set -e

REPO="himanshkukreja/markdrop"
BINARY="markdrop"
INSTALL_DIR="/usr/local/bin"

# ── Helpers ──────────────────────────────────────────────────────────────────

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }
info()  { printf '  %s\n' "$*"; }

die() { red "Error: $*"; exit 1; }

need() {
  if ! command -v "$1" > /dev/null 2>&1; then
    die "Required tool not found: $1. Please install it and re-run."
  fi
}

# ── Detect OS ────────────────────────────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux)  echo "linux"  ;;
    *)      die "Unsupported OS: $(uname -s). Use the Windows installer (install.ps1) on Windows." ;;
  esac
}

# ── Detect architecture ───────────────────────────────────────────────────────

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64)          echo "amd64" ;;
    aarch64 | arm64 | armv8) echo "arm64" ;;
    *) die "Unsupported architecture: $(uname -m)" ;;
  esac
}

# ── Fetch latest release tag from GitHub ─────────────────────────────────────

latest_tag() {
  need curl
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed 's/.*"tag_name": *"\(.*\)".*/\1/'
}

# ── Download and install ──────────────────────────────────────────────────────

main() {
  bold ""
  bold "  markdrop installer"
  info "  https://markdrop.in"
  bold ""

  OS=$(detect_os)
  ARCH=$(detect_arch)
  TAG=$(latest_tag)

  if [ -z "$TAG" ]; then
    die "Could not determine latest release. Check your internet connection."
  fi

  # Build the download URL matching GoReleaser's archive naming.
  # e.g. markdrop_0.1.0_linux_amd64.tar.gz
  VERSION="${TAG#v}"  # strip leading 'v' for the filename
  FILENAME="${BINARY}_${VERSION}_${OS}_${ARCH}.tar.gz"
  URL="https://github.com/${REPO}/releases/download/${TAG}/${FILENAME}"

  info "Version  : $TAG"
  info "Platform : ${OS}/${ARCH}"
  info "Download : $URL"
  bold ""

  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  info "Downloading…"
  curl -fsSL "$URL" -o "$TMP/$FILENAME" || die "Download failed. Check the URL above."

  info "Extracting…"
  tar -xzf "$TMP/$FILENAME" -C "$TMP"

  EXTRACTED="$TMP/$BINARY"
  if [ ! -f "$EXTRACTED" ]; then
    die "Binary not found in archive. Expected: $BINARY"
  fi
  chmod +x "$EXTRACTED"

  # Try /usr/local/bin first; fall back to ~/bin.
  if [ -w "$INSTALL_DIR" ] || sudo -n true 2>/dev/null; then
    DEST="$INSTALL_DIR/$BINARY"
    if [ ! -w "$INSTALL_DIR" ]; then
      info "Installing to $DEST (requires sudo)…"
      sudo mv "$EXTRACTED" "$DEST"
    else
      info "Installing to $DEST…"
      mv "$EXTRACTED" "$DEST"
    fi
  else
    INSTALL_DIR="$HOME/bin"
    mkdir -p "$INSTALL_DIR"
    DEST="$INSTALL_DIR/$BINARY"
    info "No write access to /usr/local/bin — installing to $DEST instead."
    info "Make sure $INSTALL_DIR is in your PATH:"
    info '  echo '\''export PATH="$HOME/bin:$PATH"'\'' >> ~/.bashrc && source ~/.bashrc'
    mv "$EXTRACTED" "$DEST"
  fi

  bold ""
  green "  ✓ markdrop $TAG installed successfully!"
  info  "  Run: markdrop --help"
  bold ""

  # Verify
  if command -v "$BINARY" > /dev/null 2>&1; then
    green "  ✓ Binary is in PATH at: $(command -v $BINARY)"
  else
    info "  Note: you may need to open a new terminal for PATH changes to take effect."
  fi
  bold ""
}

main
