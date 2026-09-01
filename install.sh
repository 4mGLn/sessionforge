#!/bin/sh
# Installs the standalone sessionforge CLI binary — no Node.js required on this machine, unlike
# `npm install -g sessionforge-cli`. Downloads the right prebuilt binary for this OS/arch from the
# latest GitHub Release and places it on PATH.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/4mGLn/sessionforge/main/install.sh | sh
#
# Override install location with SESSIONFORGE_INSTALL_DIR (default: ~/.local/bin).
set -e

REPO="4mGLn/sessionforge"
INSTALL_DIR="${SESSIONFORGE_INSTALL_DIR:-$HOME/.local/bin}"

detect_target() {
  os="$(uname -s)"
  machine_arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$machine_arch" in
        x86_64) echo "x86_64-unknown-linux-gnu" ;;
        aarch64 | arm64) echo "aarch64-unknown-linux-gnu" ;;
        *)
          echo "sessionforge: unsupported architecture '$machine_arch' on Linux" >&2
          exit 1
          ;;
      esac
      ;;
    Darwin)
      case "$machine_arch" in
        x86_64) echo "x86_64-apple-darwin" ;;
        arm64) echo "aarch64-apple-darwin" ;;
        *)
          echo "sessionforge: unsupported architecture '$machine_arch' on macOS" >&2
          exit 1
          ;;
      esac
      ;;
    *)
      echo "sessionforge: unsupported OS '$os' — on Windows, use install.ps1 instead:" >&2
      echo "  irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" >&2
      exit 1
      ;;
  esac
}

target="$(detect_target)"
asset="sessionforge-$target"
url="https://github.com/$REPO/releases/latest/download/$asset"

echo "sessionforge: downloading $asset..."
mkdir -p "$INSTALL_DIR"
tmp_file="$(mktemp)"
if ! curl -fsSL "$url" -o "$tmp_file"; then
  echo "sessionforge: download failed — is there a published release yet? https://github.com/$REPO/releases" >&2
  rm -f "$tmp_file"
  exit 1
fi
mv "$tmp_file" "$INSTALL_DIR/sessionforge"
chmod +x "$INSTALL_DIR/sessionforge"

echo "sessionforge: installed to $INSTALL_DIR/sessionforge"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo ""
    echo "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Run 'sessionforge --help' to get started (after adding it to PATH, if needed)."
