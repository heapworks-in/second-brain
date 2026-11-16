#!/usr/bin/env bash
# Pre-release check for the desktop app. Run this before publishing, every time.
#
# The point of this script is one thing: it tests the built .app's payload from a directory
# OUTSIDE the repo. Every bug that reached a release did so because verification happened inside
# the repo, where the environment is quietly more forgiving than a real install:
#
#   - `node server.js` run from .next/standalone resolves require() upward into the repo's own
#     node_modules, so packages missing from the bundle still loaded. linkedom and sqlite-vec
#     shipped broken this way ("Module not found") and passed local testing every time.
#   - `swift build` run against helper/ in the repo passed while the bundled copy was missing
#     Package.swift entirely.
#   - Checking that a directory exists says nothing about whether the package inside it can load.
#
# So: copy what the app actually ships, put it somewhere with no parent node_modules, and use it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/desktop/src-tauri/target/release/bundle/macos/Second Brain.app"
RESOURCES="$APP/Contents/Resources/server"
PORT="${SMOKE_PORT:-13999}"

WORK=""
SERVER_PID=""

cleanup() {
  # Kill by PID, never by name pattern: Next renames its process title to "next-server", so
  # `pkill -f "node server.js"` silently matches nothing and leaves the process running. That
  # exact mistake leaked a server that ran for 17 hours.
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  [ -n "$WORK" ] && rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf '\033[32m  ok\033[0m   %s\n' "$*"; }
fail() { printf '\033[31m  FAIL\033[0m %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
step() { printf '\n\033[36m▸\033[0m %s\n' "$*"; }
FAILURES=0

[ -d "$APP" ] || { echo "no built app at $APP -- run 'cargo tauri build' first"; exit 1; }

step "Bundle payload"
for f in server.js scripts/brain.sh helper/activity/Package.swift helper/recorder/Package.swift .next/static; do
  if [ -e "$RESOURCES/$f" ]; then pass "$f"; else fail "$f missing from the bundle"; fi
done
# public/ is empty in this repo, and both cp and Tauri's bundler drop empty directories -- so its
# absence is expected, and only its *contents* going missing would be a real problem.
if [ "$(find "$ROOT/public" -type f 2>/dev/null | wc -l | tr -d ' ')" -gt 0 ] && [ ! -d "$RESOURCES/public" ]; then
  fail "public/ has files in the repo but is missing from the bundle"
else
  pass "public/ (empty in repo, nothing to ship)"
fi
# The Turbopack alias directory the server requires externals through. Must be real directories:
# symlinks here are dropped by both the .app bundler and the install-time copy.
if [ -d "$RESOURCES/.next/node_modules" ]; then
  if find "$RESOURCES/.next/node_modules" -maxdepth 2 -type l | grep -q .; then
    fail ".next/node_modules contains symlinks -- they will be dropped on install"
  else
    pass ".next/node_modules present, no symlinks ($(ls "$RESOURCES/.next/node_modules" | wc -l | tr -d ' ') aliases)"
  fi
else
  fail ".next/node_modules missing -- externals will fail to resolve at runtime"
fi
if [ -d "$RESOURCES/desktop" ]; then
  fail "desktop/ leaked into the bundle ($(du -sh "$RESOURCES/desktop" | cut -f1)) -- the rm -rf step was skipped"
else
  pass "desktop/ correctly absent"
fi
# The bundled Chrome adaptor sits beside server/, not inside it. A build run without the sibling
# sb-adaptors repo checked out produces a working app with nothing to offer in Settings > Slack,
# and that is silent without this.
if [ -f "$RESOURCES/../extension/manifest.json" ]; then
  pass "Chrome adaptor bundled"
else
  fail "no Chrome adaptor in the bundle -- the copy from ../sb-adaptors was skipped"
fi

step "Extract to a directory outside the repo"
WORK="$(mktemp -d)"
INSTALL="$WORK/current"
mkdir -p "$INSTALL"
cp -R "$RESOURCES/." "$INSTALL/"
pass "extracted to $INSTALL ($(find "$INSTALL" -type f | wc -l | tr -d ' ') files)"

step "Externalized packages actually load (not merely resolve)"
# require(), not require.resolve(): resolve only proves an entry point exists, and these packages
# have native bindings and side-effectful loads that can fail well after resolution succeeds.
( cd "$INSTALL" && node -e '
  const names = ["better-sqlite3","sqlite-vec","@huggingface/transformers","pdf-parse","tesseract.js","linkedom","@mozilla/readability"];
  let bad = 0;
  for (const n of names) {
    try { require(n); console.log("  ok   " + n); }
    catch (e) { console.log("  FAIL " + n + " -> " + String(e.message).split("\n")[0]); bad++; }
  }
  process.exit(bad ? 1 : 0);
' ) || FAILURES=$((FAILURES + 1))

step "Swift helpers build from the bundled source"
if command -v swift >/dev/null 2>&1; then
  for pkg in recorder activity; do
    if ( cd "$INSTALL/helper/$pkg" && swift build -c release >/dev/null 2>&1 ); then
      pass "helper/$pkg builds"
    else
      fail "helper/$pkg does not build from the bundled copy"
    fi
  done
  # Slack's message list mixes messages with date separators, the unread divider and a bottom
  # spacer, all sharing one DOM-id prefix. Mistake a separator for a message and the desk is handed
  # "Friday, November 6th" as something a colleague is waiting on. Offline and deterministic -- it
  # asserts against ids captured from a real workspace, so it needs no Slack and no permission.
  if [ -x "$INSTALL/helper/activity/.build/release/sb-activity" ]; then
    if "$INSTALL/helper/activity/.build/release/sb-activity" --slack-self-check >/dev/null 2>&1; then
      pass "slack row parsing holds"
    else
      fail "slack row parsing is wrong -- it would read a date separator as a message"
    fi
  fi
  rm -rf "$INSTALL/helper"/*/.build
else
  echo "  -- swift not installed, skipping (matches how brain.sh degrades)"
fi

step "brain.sh bootstrap (the fast half the server needs)"
BOOT_HOME="$WORK/home"
mkdir -p "$BOOT_HOME"
if ( cd "$INSTALL" && HOME="$BOOT_HOME" SB_DATA_DIR="$WORK/data" bash scripts/brain.sh bootstrap >/dev/null 2>&1 ); then
  pass "bootstrap completed"
else
  fail "bootstrap failed"
fi
# Checked by reading the dispatcher, never by running it. brain.sh ignores extra arguments, so
# `fetch-assets --help` is not a dry run -- it executes the real thing, which calls helper_stop,
# and `launchctl bootout` acts on the user's GUI domain regardless of an isolated HOME. Running it
# here stopped the developer's actual activity helper.
grep -q "fetch-assets) cmd_fetch_assets" "$INSTALL/scripts/brain.sh" && pass "fetch-assets is dispatchable" || fail "fetch-assets missing from dispatcher"

step "Server boots and serves real pages, with no repo to fall back on"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  fail "port $PORT is already in use -- a previous run leaked a server; free it and rerun"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t | sed 's/^/      stale PID: /'
  exit 1
fi
# `exec` matters: without it the backgrounded job is a subshell that spawns node as a child, so $!
# is the subshell's PID and killing it leaves node running and holding the port. exec replaces the
# subshell with node itself, making $! the PID we actually need to kill.
( cd "$INSTALL" && exec env HOME="$BOOT_HOME" SB_DATA_DIR="$WORK/data" PORT="$PORT" \
    HOSTNAME=127.0.0.1 node server.js ) > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/capture" 2>/dev/null && break
  sleep 0.5
done

ROUTE_FAILED=0
for route in / /today /capture /planner /inbox /search /log /goals /review /desk /insights; do
  code="$(curl -sSL -o "$WORK/body" -w '%{http_code}' "http://127.0.0.1:$PORT$route" 2>/dev/null || echo 000)"
  if [ "$code" = "200" ] && ! grep -qi "internal server error\|application error" "$WORK/body"; then
    pass "$route -> 200"
  else
    fail "$route -> $code"
    ROUTE_FAILED=1
  fi
done

# Print the actual server error inline. Without this, a failing run only says "500" and diagnosing
# it means manually reproducing the whole extract-and-boot sequence by hand.
if [ "$ROUTE_FAILED" = "1" ]; then
  echo "      ---- server log (first error) ----"
  grep -m1 -A4 -iE "error|cannot find|failed" "$WORK/server.log" 2>/dev/null | sed 's/^/      /' || true
fi

if grep -qiE "cannot find module|module not found|MODULE_NOT_FOUND" "$WORK/server.log"; then
  fail "server log contains module resolution errors:"
  grep -iE "cannot find module|module not found|MODULE_NOT_FOUND" "$WORK/server.log" | head -5 | sed 's/^/      /'
else
  pass "no module resolution errors in the server log"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[32mall checks passed\033[0m -- safe to release\n'
else
  printf '\033[31m%s check(s) failed\033[0m -- do not release\n' "$FAILURES"
  echo "server log: $WORK/server.log (kept until this script exits)"
  exit 1
fi
