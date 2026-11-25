#!/usr/bin/env bash
# IMA Reply Tracking installer, macOS / Linux launcher.
# Doctors run ONE line (the organizer sends it with their personal invite code):
#
#   curl -fsSL https://raw.githubusercontent.com/amits-ds/ima-reply-tracking-addon/main/install/install.sh | bash -s -- --code XXXX-XXXX-XXXX-XXXX
#
# This file only makes sure Node.js 18+ is available (a private portable copy in ~/.ima-reply-tracking/node, no admin rights,
# nothing changed system-wide), downloads install.js from the same repository and runs it. All the real work is in install.js.
# Extra options are passed to install.js (--gateway, --release-base, --source, --dry-run, --yes, --no-open).
# Testing: REPLY_TRACKING_LOCAL_INSTALLER=/path/to/install.js uses a local install.js (no checksum check);
#          REPLY_TRACKING_INSTALLER_URL=<url or file://...> downloads install.js from there (checksum still enforced).
set -euo pipefail

REPO="amits-ds/ima-reply-tracking-addon"
REF="main"                                          # replaced by tools/release.py with the release tag
EXPECTED_SHA256="6b61c7b7a123ae22eb72894438f73b354abfbe898e9c656a685588450c0486b0"            # replaced by tools/release.py: SHA-256 of install.js for this release
ROOT="$HOME/.ima-reply-tracking"
NODE_DIR="$ROOT/node"
mkdir -p "$ROOT"

node_major() { "$1" -v 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p'; }

find_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node_major "$(command -v node)")" -ge 18 ] 2>/dev/null; then command -v node; return; fi
  if [ -x "$NODE_DIR/bin/node" ] && [ "$(node_major "$NODE_DIR/bin/node")" -ge 18 ] 2>/dev/null; then echo "$NODE_DIR/bin/node"; return; fi

  echo "Downloading a private copy of Node.js (one time, about 40 MB)..." >&2
  local os arch base line file hash
  case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo "Unsupported system: $(uname -s)" >&2; exit 1;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) echo "Unsupported processor: $(uname -m)" >&2; exit 1;; esac
  base="https://nodejs.org/dist/latest-v22.x"
  line="$(curl -fsSL "$base/SHASUMS256.txt" | grep -E "node-v[0-9.]+-$os-$arch\.tar\.gz\$" | head -n1)"
  [ -n "$line" ] || { echo "Could not find a Node.js download for $os-$arch." >&2; exit 1; }
  hash="${line%% *}"; file="${line##* }"
  curl -fsSL "$base/$file" -o "$ROOT/$file"
  local got
  if command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "$ROOT/$file" | cut -d' ' -f1)"; else got="$(sha256sum "$ROOT/$file" | cut -d' ' -f1)"; fi
  [ "$got" = "$hash" ] || { rm -f "$ROOT/$file"; echo "The Node.js download failed its checksum. Try again." >&2; exit 1; }
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  tar -xzf "$ROOT/$file" -C "$NODE_DIR" --strip-components=1
  rm -f "$ROOT/$file"
  echo "$NODE_DIR/bin/node"
}

NODE="$(find_node)"
export PATH="$(dirname "$NODE"):$PATH"      # so npm (used by the installer) finds this node

if [ -n "${REPLY_TRACKING_LOCAL_INSTALLER:-}" ]; then INSTALLER="$REPLY_TRACKING_LOCAL_INSTALLER"
else
  INSTALLER="$ROOT/install.js"
  curl -fsSL "${REPLY_TRACKING_INSTALLER_URL:-https://raw.githubusercontent.com/$REPO/$REF/install/install.js}" -o "$INSTALLER"
  case "$EXPECTED_SHA256" in
    PASTE_*) rm -f "$INSTALLER"; echo "This launcher has no checksum for install.js, so it refuses to run it. Ask the organizer for a current command." >&2; exit 1;;
  esac
  if command -v shasum >/dev/null 2>&1; then GOT="$(shasum -a 256 "$INSTALLER" | cut -d' ' -f1)"; else GOT="$(sha256sum "$INSTALLER" | cut -d' ' -f1)"; fi
  if [ "$GOT" != "$EXPECTED_SHA256" ]; then
    rm -f "$INSTALLER"
    echo "install.js does not match its published checksum (expected $EXPECTED_SHA256, got $GOT). Nothing was run." >&2
    exit 1
  fi
fi

# When this script is piped into bash, stdin is the script text, so give the installer the real keyboard.
if { : < /dev/tty; } 2>/dev/null; then exec "$NODE" "$INSTALLER" "$@" < /dev/tty; else exec "$NODE" "$INSTALLER" "$@"; fi
