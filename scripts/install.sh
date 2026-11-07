#!/usr/bin/env sh
set -e

# Sajimora Native Installer
# Supports macOS (Apple Silicon & Intel) and Linux (x86_64)

REPO="Jagadeesh-Budda/Sajimora-v0.10"
LATEST_TAG=$(curl -s "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$LATEST_TAG" ]; then
  LATEST_TAG="v0.10.0"
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64) TARGET="aarch64-apple-darwin" ;;
      x86_64) TARGET="x86_64-apple-darwin" ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported operating system: $OS"
    echo "For Windows, download sajimora-windows-x86_64.zip from GitHub Releases."
    exit 1
    ;;
esac

ASSET="sajimora-${LATEST_TAG}-${TARGET}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ASSET}"
INSTALL_DIR="/usr/local/bin"

echo "⚡ Downloading Sajimora ${LATEST_TAG} for ${TARGET}..."
TMP_DIR=$(mktemp -d)
curl -sL "$URL" -o "${TMP_DIR}/${ASSET}"
tar -xzf "${TMP_DIR}/${ASSET}" -C "$TMP_DIR"

if [ -w "$INSTALL_DIR" ]; then
  mv "${TMP_DIR}/sajimora" "$INSTALL_DIR/sajimora"
  [ -f "${TMP_DIR}/sajimora-mcp" ] && mv "${TMP_DIR}/sajimora-mcp" "$INSTALL_DIR/sajimora-mcp"
else
  echo "Elevated permissions required to install to $INSTALL_DIR:"
  sudo mv "${TMP_DIR}/sajimora" "$INSTALL_DIR/sajimora"
  [ -f "${TMP_DIR}/sajimora-mcp" ] && sudo mv "${TMP_DIR}/sajimora-mcp" "$INSTALL_DIR/sajimora-mcp"
fi

rm -rf "$TMP_DIR"
chmod +x "$INSTALL_DIR/sajimora"
echo "✅ Successfully installed Sajimora to $INSTALL_DIR/sajimora"
echo "   Run 'sajimora --help' to get started."
