#!/bin/sh
set -eu

CONTROL_PLANE_URL="${DRIFTVERK_CONTROL_PLANE_URL:-https://app.driftverk.com}"
INSTALL_DIR="${DRIFTVERK_BIN_DIR:-/usr/local/bin}"
fail() { printf 'Error: %s\n' "$1" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "curl is required."
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "Use the PowerShell installer on Windows. Supported systems: macOS, Linux, Windows." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "Supported architectures: Intel/AMD 64-bit and ARM64." ;;
esac
filename="driftverk-$os-$arch"
download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT HUP INT TERM
curl -fsSL "${CONTROL_PLANE_URL%/}/install/bin/$filename" -o "$download_dir/$filename" || fail "Could not download the Driftverk CLI."
curl -fsSL "${CONTROL_PLANE_URL%/}/install/bin/$filename.sha256" -o "$download_dir/checksum" || fail "Could not download the CLI checksum."
expected="$(awk 'NR == 1 {print $1}' "$download_dir/checksum")"
[ "${#expected}" -eq 64 ] || fail "Invalid CLI checksum."
case "$expected" in *[!0-9a-fA-F]*) fail "Invalid CLI checksum." ;; esac
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$download_dir/$filename" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$download_dir/$filename" | awk '{print $1}')"
else
  fail "A SHA-256 tool is required: sha256sum or shasum."
fi
[ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" = "$actual" ] || fail "CLI checksum mismatch. Existing installation was not changed."

if { [ -d "$INSTALL_DIR" ] && [ -w "$INSTALL_DIR" ]; } || { [ ! -e "$INSTALL_DIR" ] && mkdir -p "$INSTALL_DIR" 2>/dev/null; }; then
  install -m 0755 "$download_dir/$filename" "$INSTALL_DIR/driftverk"
elif command -v sudo >/dev/null 2>&1; then
  sudo mkdir -p "$INSTALL_DIR"
  sudo install -m 0755 "$download_dir/$filename" "$INSTALL_DIR/driftverk"
else
  fail "Cannot write to ${INSTALL_DIR}. Set DRIFTVERK_BIN_DIR to a writable directory."
fi
printf 'Installed Driftverk CLI\n'
