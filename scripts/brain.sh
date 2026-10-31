#!/usr/bin/env bash
# Second Brain lifecycle: setup, start, stop, restart, status, logs, dev.
# The app runs as a launchd user agent so it starts at login and stays up.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.second-brain.app"
PORT="${SB_PORT:-3141}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
URL="http://127.0.0.1:$PORT"
HELPER_LABEL="com.second-brain.activity"
HELPER_PLIST="$HOME/Library/LaunchAgents/$HELPER_LABEL.plist"
HELPER_SRC="$ROOT/helper/activity"
RECORDER_SRC="$ROOT/helper/recorder"
WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
GIST_URL="https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
SUMMARY_URL="https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf"

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Every DATA_DIR-derived path in one place, so moving it (set-data-dir) only ever means calling
# this again with the new location -- never editing a scattered second copy of each path.
set_data_dir_vars() {
  DATA_DIR="$1"
  LOG_DIR="$DATA_DIR/logs"
  LOG_FILE="$LOG_DIR/app.log"
  DB_FILE="$DATA_DIR/brain.db"
  BACKUPS_DIR="$DATA_DIR/backups"
  HELPER_BIN="$DATA_DIR/bin/sb-activity"
  HELPER_LOG="$LOG_DIR/activity.log"
  TOKEN_FILE="$DATA_DIR/activity-token"
  RECORDER_BIN="$DATA_DIR/bin/sb-recorder"
  WHISPER_DIR="$DATA_DIR/models/whisper"
}

# The installed launch agent's own plist is the one persisted record of where data actually
# lives, once `setup` or `set-data-dir` has written it -- SB_DATA_DIR (or the hardcoded default)
# only matters before that plist exists, i.e. a first-ever setup. Every other invocation of this
# script, in any shell, reads the plist back rather than re-deriving a path that may have moved
# since, which is what let a plain env var go stale the moment someone forgot to export it again.
resolved_data_dir() {
  if [ -f "$PLIST" ]; then
    /usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:SB_DATA_DIR' "$PLIST" 2>/dev/null && return 0
  fi
  echo "${SB_DATA_DIR:-$HOME/Library/Application Support/second-brain}"
}

set_data_dir_vars "$(resolved_data_dir)"

usage() {
  cat <<USAGE
Usage: scripts/brain.sh <command>

  setup            install deps, build, download the embedding and whisper models, install the launch agent, the activity helper and the recorder, start
  update           after pulling changes: install deps, rebuild the app and both helpers, fetch any missing models, restart
  start            start the launch agent and open the browser
  stop             stop the launch agent and the activity helper
  restart [--build] [--helpers]
                   stop, rebuild the app (--build) and/or the Swift helpers (--helpers), start
  helpers          rebuild and reinstall the activity helper and the recorder, then bounce the helper
  status           show agent, server, tool and helper state
  logs             tail the server log
  open             open the app in the browser
  dev              run the dev server in the foreground (port $PORT)
  backup           take a backup right now and verify it
  verify           open every backup, print one line each, and fail if any is unsound
  restore [file]   with no file, list what is available and stop; with one, replace the
                   live database with it -- see docs/superpowers/runbook.md first
  audio-status     how many meeting recordings are held, how much space, when the next
                   release is due -- read-only
  release-audio    run design's audio-release pass right now, rather than waiting for
                   tonight's backup job to get to it
  set-data-dir <path>
                   move everything in the data directory to <path>, point both launch
                   agents at it, and restart -- no reinstall, no rebuild, no re-download
  prepare          everything setup does except building the app and installing its own
                   launch agent -- bootstrap plus fetch-assets, in that order
  bootstrap        just what the server needs before it can boot (data dirs, auth token).
                   Sub-second, no network -- the desktop app runs this, starts the server,
                   and only then fetches assets, so the app is usable while they download
  fetch-assets     the slow half of prepare: every model, Homebrew's llama.cpp, the Swift
                   helper and recorder. Safe to run while the server is already up

Data directory: $DATA_DIR
(SB_DATA_DIR only matters before the first setup; after that, run set-data-dir to move it)
USAGE
}

require_node() {
  command -v node >/dev/null || fail "node not found. Install Node 22 or newer."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || fail "Node 22 or newer required, found $(node -v)."
  command -v npm >/dev/null || fail "npm not found."
}

is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
is_up()     { curl -sf -o /dev/null --max-time 2 "$URL/capture"; }

# The PID listening on $PORT, empty when nothing is. A server left behind by an ad-hoc run holds
# the port; the agent then exits 1 on every spawn and launchd retries forever with nothing on
# screen saying why -- 1605 silent respawns over twelve hours, in the case that prompted this.
#
# The trailing `|| true` is load-bearing, not defensive: `lsof` exits 1 when nothing is listening,
# and under this script's `set -o pipefail` that failure becomes the function's status, so
# `holder=$(port_holder)` would abort the caller on a free port -- the one case that must succeed.
port_holder() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
# What the agent's last spawn did, for when the port is free and it still will not stay up. Same
# `|| true` reason: `launchctl print` fails when the agent is not loaded.
last_exit() { launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk -F'= ' '/last exit code/ {print $2; exit}' || true; }

wait_for_server() {
  local i
  for i in $(seq 1 60); do
    if is_up; then return 0; fi
    sleep 1
  done
  return 1
}

helper_loaded() { launchctl print "$DOMAIN/$HELPER_LABEL" >/dev/null 2>&1; }

ensure_token() {
  if [ ! -s "$TOKEN_FILE" ]; then
    mkdir -p "$DATA_DIR"
    (umask 077; head -c 32 /dev/urandom | xxd -p -c 64 > "$TOKEN_FILE")
    ok "activity token written"
  fi
}

# Accessibility is granted to a *build* of the helper, not to the helper. The binary is ad-hoc
# signed (`Signature=adhoc`, no team identifier), so it has no stable identity for macOS to key a
# grant to and tccd can only pin the cdhash of the exact file it was shown. Rebuilding changes that
# hash and silently voids the grant: System Settings goes on showing the entry with its switch on,
# while tccd logs "Failed to match existing code requirement" and denies. Observed for real -- a
# grant made before a rebuild left `accessibility: missing` with no visible reason.
#
# Saying *when* is what makes that actionable, and the binary's own mtime already records it -- no
# stamp file to write, and it works on an install that predates this code, which a new stamp would
# not. tccd's own denial is the definitive evidence, but it is only logged when the helper first
# asks, so it is reliably absent by the time anyone runs `status`: measured over 25 minutes of a
# denied helper, not assumed.
helper_build_date() {
  [ -f "$HELPER_BIN" ] || return 0
  stat -f "%Sm" -t "%e %b %Y at %H:%M" "$HELPER_BIN" 2>/dev/null | sed 's/^ *//' || true
}

# Why `accessibility: missing` may be showing even though the switch looks on, and what to do.
accessibility_advice() {
  local when; when="$(helper_build_date)"
  printf '  Accessibility is bound to the exact build it was granted to: the helper is ad-hoc signed,
'
  printf '  so macOS pins the grant to that one file and a rebuild voids it -- while System Settings
'
  printf '  carries on showing the entry with its switch on.
'
  if [ -n "$when" ]; then
    printf '  This helper was last rebuilt on %s; a grant given before then no longer applies.
' "$when"
  fi
  printf '  Toggling it off and on reuses the same stale entry, so remove it and add it again:
'
  printf '    System Settings > Privacy & Security > Accessibility
'
  printf '    select sb-activity, press [-], then press [+] and choose:
'
  printf '      %s
' "$HELPER_BIN"
  printf '    then: launchctl kickstart -k %s/%s
' "$DOMAIN" "$HELPER_LABEL"
}

# Puts a freshly built helper where the app expects it, through a new inode rather than by
# writing over the old file.
#
# Overwriting an executable is not merely racy on macOS, it is destructive. Write over a file
# while any process is executing it and the kernel's cached page hashes for that inode stop
# matching its contents, so *every later* exec of that path is killed outright with SIGKILL --
# and it stays that way after the original process has long gone. Measured: `cp` over an idle
# binary and running it exits 0; `cp` over a running one makes every run after it exit 137
# (128 + SIGKILL).
#
# Both helpers were installed that way, and the recorder is the one that got executed often
# enough to collide: the server runs `sb-recorder --permissions` on several page loads (30 s
# cache -- src/domain/meetings/tools.ts), and the desktop app re-runs `fetch-assets` on every
# single launch. One `cp` landing on top of one of those checks poisoned the binary for the rest
# of the session, which is exactly what "the recorder sometimes doesn't start" and a bare
# "recorder exited with SIGKILL" with no stderr behind it were: the helper was killed before it
# ran a single instruction, so it had nothing to say for itself.
#
# `mv` within the same directory is a rename: the new file gets its own inode, anyone still
# running the old one keeps a working copy of it, and no byte is ever written through a path that
# something might be executing.
install_binary() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest.new" || return 1
  chmod +x "$dest.new"
  mv -f "$dest.new" "$dest"
}

build_helper() {
  if ! command -v swift >/dev/null; then
    say "swift not found; skipping the activity helper. Install the Xcode command line tools and rerun setup to enable it."
    return 1
  fi
  say "building the activity helper"
  if ! (cd "$HELPER_SRC" && swift build -c release 2>&1 | tail -3); then
    say "the activity helper did not build; skipping it"
    return 1
  fi
  install_binary "$HELPER_SRC/.build/release/sb-activity" "$HELPER_BIN" || return 1
  ok "helper built at $HELPER_BIN"
  say "this rebuild voided any Accessibility grant the previous build had -- 'scripts/brain.sh status' says how to restore it"
}

write_helper_plist() {
  cat > "$HELPER_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$HELPER_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HELPER_BIN</string>
    <string>--server</string>
    <string>$URL</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SB_DATA_DIR</key><string>$DATA_DIR</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HELPER_LOG</string>
  <key>StandardErrorPath</key><string>$HELPER_LOG</string>
</dict>
</plist>
PLIST
  ok "helper launch agent written to $HELPER_PLIST"
}

build_recorder() {
  if ! command -v swift >/dev/null; then
    say "swift not found; skipping the meeting recorder. Install the Xcode command line tools and rerun setup to enable it."
    return 1
  fi
  say "building the meeting recorder"
  if ! (cd "$RECORDER_SRC" && swift build -c release 2>&1 | tail -3); then
    say "the meeting recorder did not build; skipping it"
    return 1
  fi
  install_binary "$RECORDER_SRC/.build/release/sb-recorder" "$RECORDER_BIN" || return 1
  ok "recorder built at $RECORDER_BIN"
}

# Download a model unless it is already there. An existing model is never touched. The summary
# model alone is ~4.4 GB, so a transient failure (dropped connection, brief network blip) shouldn't
# mean starting over from zero: --retry handles a blip within this one invocation, and -C - resumes
# from whatever .part a previous, ultimately-failed attempt left behind -- which is deliberately
# kept on failure now, not deleted, specifically so the next prepare/setup run can pick up where
# this one left off instead of re-downloading bytes already on disk.
#
# curl's own --progress-bar draws with \r (no newline), so it's invisible to a line-by-line reader
# -- which is exactly how the desktop app's setup screen consumes this script's output. Instead,
# curl runs in the background and a poll loop emits `SB_PROGRESS|<label>|<percent>` lines (real
# newlines) while it runs; the desktop app's Rust side (src-tauri/src/lib.rs) recognizes that
# prefix and turns it into a UI progress bar instead of a log line. A plain terminal run of this
# script just prints those lines like any other -- no worse than before, since --progress-bar's
# \r output was never useful in a piped/logged context either.
fetch_model() {
  # `label` is the precise one for logs (it names the exact checkpoint and quantization, which is
  # what you want when diagnosing a bad download); `display` is what the setup screen's progress
  # bar shows, in terms of the feature it powers rather than the model that powers it. Defaults to
  # label when a caller doesn't care to distinguish them.
  local dest="$1" url="$2" label="$3" consequence="$4" display="${5:-$3}"
  if [ -s "$dest" ]; then
    ok "$label already at $dest"
    return 0
  fi
  say "downloading the $label model ($url)"

  local total
  total="$(curl -sIL "$url" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" {size=$2} END {print size}')"

  # --silent --show-error, not --progress-bar: our own poll loop below is the real progress signal
  # now, and curl's \r-based meter would otherwise accumulate unread (no newline to flush it) until
  # one huge garbled line lands in the log at the very end. --show-error keeps real error text on
  # failure despite --silent.
  curl -L --fail --silent --show-error --retry 3 --retry-delay 5 --retry-all-errors -C - -o "$dest.part" "$url" &
  local curl_pid=$!

  if [ -n "${total:-}" ] && [ "$total" -gt 0 ] 2>/dev/null; then
    local last_percent=-1 current percent
    while kill -0 "$curl_pid" 2>/dev/null; do
      if [ -f "$dest.part" ]; then
        current=$(wc -c <"$dest.part" 2>/dev/null | tr -d ' ')
        if [ -n "$current" ]; then
          percent=$((current * 100 / total))
          if [ "$percent" -ne "$last_percent" ]; then
            echo "SB_PROGRESS|$display|$percent"
            last_percent=$percent
          fi
        fi
      fi
      sleep 1
    done
  fi

  if wait "$curl_pid"; then
    mv "$dest.part" "$dest"
    ok "$label downloaded to $dest"
    echo "SB_PROGRESS|$display|100"
  else
    say "could not download the $label model; $consequence (will resume from where it left off next time)"
    return 1
  fi
}

# The final pass runs large-v3-turbo rather than medium.en: it is more accurate on English and
# several times faster, for 86 MB more than the model it replaces. It is a multilingual
# checkpoint, so both passes are locked to English with `-l en` (live.ts, transcribe-final.ts) --
# which is also what keeps accented English from being written off as "[NON-ENGLISH SPEECH]", the
# way the English-only models did.
#
# An install that already has medium.en keeps using it until this downloads; nothing is deleted,
# so falling back is a settings change rather than a re-download.
download_whisper_models() {
  mkdir -p "$WHISPER_DIR"
  local base="$WHISPER_DIR/ggml-base.en.bin"
  local final="$WHISPER_DIR/ggml-large-v3-turbo.bin"
  local brew_final="$HOME/.whisper-cpp/models/ggml-large-v3-turbo.bin"
  fetch_model "$base" "$WHISPER_URL/ggml-base.en.bin" "whisper base.en" "meetings will not transcribe" "the live transcription model" || true
  if [ -s "$final" ]; then
    ok "whisper large-v3-turbo already at $final"
  elif [ -s "$brew_final" ]; then
    # whisper-cpp from Homebrew already has it; link rather than fetch 1.5 GB
    # again. The link, not its target, is the one path everything else names.
    ln -sf "$brew_final" "$final"
    ok "linked the medium.en model already at $brew_final"
  else
    fetch_model "$final" "$WHISPER_URL/ggml-large-v3-turbo.bin" "whisper large-v3-turbo" "the final (post-meeting) transcript pass will fail until it is there -- live transcription during the meeting still works" "the full transcription model" || true
  fi
  write_model_settings "$base" "$final"
}

# Distill's local gist step (src/providers/gist) needs both `llama-cli` and the model below;
# missing either just leaves that one feature off (`getGistProvider()` returns null), so nothing
# here is ever fatal to setup -- Homebrew missing, or the install itself failing, only means the
# gist step stays off until it's sorted out by hand.
ensure_llama_cli() {
  if tool_path llama-cli >/dev/null 2>&1; then
    ok "llama.cpp already installed"
    return 0
  fi
  if ! command -v brew >/dev/null 2>&1; then
    say "llama.cpp not installed and Homebrew isn't on PATH; the local gist model will stay off until you run: brew install llama.cpp"
    return 0
  fi
  say "installing llama.cpp (brew) for the local gist model"
  if brew install llama.cpp; then
    ok "llama.cpp installed"
  else
    say "brew install llama.cpp failed; the local gist model will stay off until it succeeds"
  fi
}

download_gist_model() {
  local dir="$DATA_DIR/models/gist"
  local target="$dir/model.gguf"
  mkdir -p "$dir"
  ensure_llama_cli
  fetch_model "$target" "$GIST_URL" "gist (Qwen2.5-0.5B-Instruct, Q4_K_M)" "note distillation will stay off" "the note distillation model" || true
}

# Meeting summaries (src/jobs/handlers/summarize-meeting.ts) used to need an Anthropic key;
# now they need this instead -- a bigger local model than the gist one, because reasoning over
# a whole transcript into a summary, decisions and proposed actions asks more of it than
# paraphrasing a few quotes does. Same binary as the gist model (ensure_llama_cli installs it
# once), same "off, not broken" shape when the ~4.4 GB download hasn't happened yet.
download_summary_model() {
  local dir="$DATA_DIR/models/summary"
  local target="$dir/model.gguf"
  mkdir -p "$dir"
  ensure_llama_cli
  fetch_model "$target" "$SUMMARY_URL" "summary (Qwen2.5-7B-Instruct, Q4_K_M)" "meeting summaries will stay off" "the meeting summary model" || true
}

# The live and the final transcription models, as meetings.whisperBase and
# meetings.whisperFinal. Before the first run of the app there is no database to
# write to; the defaults in src/domain/meetings/tools.ts already name these paths.
write_model_settings() {
  (cd "$ROOT" && SB_DB="$DATA_DIR/brain.db" SB_BASE="$1" SB_FINAL="$2" node -e '
    const fs = require("fs");
    const file = process.env.SB_DB;
    if (!fs.existsSync(file)) { console.log("  settings skipped until the app has created its database (defaults match)"); process.exit(0); }
    const db = new (require("better-sqlite3"))(file);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").get("table", "settings");
    if (!table) { console.log("  settings skipped until the app has created its database (defaults match)"); process.exit(0); }
    const set = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    set.run("meetings.whisperBase", process.env.SB_BASE);
    set.run("meetings.whisperFinal", process.env.SB_FINAL);
    console.log("  whisper models recorded in settings");
  ')
}

# The first run raises the macOS prompts; nothing can be recorded before they are answered.
probe_recorder() {
  if [ ! -x "$RECORDER_BIN" ]; then
    say "recorder not installed; skipping the permission check"
    return 0
  fi
  say "checking recording permissions - macOS asks for Microphone and, on 14.2+, System Audio Recording. Allow both."
  if "$RECORDER_BIN" --probe; then
    ok "recorder captured audio"
  else
    say "the recorder captured nothing. Grant the prompts, then run: $RECORDER_BIN --probe"
  fi
}

helper_start() {
  if [ ! -f "$HELPER_PLIST" ] || [ ! -x "$HELPER_BIN" ]; then
    say "activity helper not installed (run setup with swift available)"
    return 0
  fi
  if helper_loaded; then say "helper already loaded"; else launchctl bootstrap "$DOMAIN" "$HELPER_PLIST"; ok "helper loaded"; fi
}

helper_stop() {
  if helper_loaded; then launchctl bootout "$DOMAIN/$HELPER_LABEL" || true; ok "helper stopped"; fi
}

helper_status() {
  if helper_loaded; then ok "activity helper loaded"; else say "activity helper not loaded"; fi
  # Permissions are reported from what the *running* helper last told the server, never by running
  # `--once` here. macOS grants TCC per executing process context, so a helper launched from this
  # shell inherits the terminal's grants, not the launch agent's -- the two disagree completely in
  # practice. This printed "calendar: missing" while the actual daemon had calendar access and was
  # reading 9 calendars, which is a good way to spend an afternoon debugging the wrong thing.
  local reported
  reported="$(is_up && curl -sf --max-time 2 "$URL/api/activity/status" 2>/dev/null || true)"
  if [ -n "$reported" ]; then
    printf '%s' "$reported" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { const h = JSON.parse(s).helper; const p = h.permissions;
          console.log(`  accessibility: ${p.accessibility ? "granted" : "missing"}  calendar: ${p.calendar ? "granted" : "missing"}  (as reported by the running helper, last seen ${h.lastSeen ?? "never"})`);
        } catch { console.log("  helper has not reported permissions yet"); }
      });'
    # Asked of the same payload rather than re-fetched, so the advice can never disagree with the
    # line printed above it.
    local access
    access="$(printf '%s' "$reported" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { console.log(JSON.parse(s).helper.permissions.accessibility ? "granted" : "missing"); } catch { console.log("unknown"); }
      });' 2>/dev/null || true)"
    if [ "$access" = "missing" ]; then accessibility_advice; fi
  else
    printf '  permissions: unknown (server not answering)\n'
  fi
  if [ -n "$reported" ]; then
    printf '%s' "$reported" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try { const n = JSON.parse(s).helper.calendarsSeen;
          console.log(`  calendars: ${typeof n === "number" ? n : "unknown"}`);
        } catch { console.log("  calendars: unknown"); }
      });'
  else
    printf '  calendars: unknown\n'
  fi
}

# Homebrew prefixes are searched explicitly: launchd agents do not inherit them.
tool_path() {
  local name="$1" dir
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return 0; fi
  for dir in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$dir/$name" ]; then echo "$dir/$name"; return 0; fi
  done
  return 1
}

tool_line() {
  if [ -n "${2:-}" ] && [ -x "${2:-}" ]; then ok "$1: ok"; else say "$1: missing"; fi
}

write_plist() {
  local node_bin node_dir
  node_bin="$(command -v node)"
  node_dir="$(dirname "$node_bin")"
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_bin</string>
    <string>$ROOT/node_modules/next/dist/bin/next</string>
    <string>start</string>
    <string>-p</string>
    <string>$PORT</string>
    <string>-H</string>
    <string>127.0.0.1</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$node_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key><string>production</string>
    <key>SB_DATA_DIR</key><string>$DATA_DIR</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
PLIST
  ok "launch agent written to $PLIST"
}

download_model() {
  # Same model and dtype as src/providers/embed/transformers.ts; keep them in sync.
  # Never fatal, same as the other three models below -- a failure here should leave semantic
  # search off, not take the rest of setup (llama.cpp, whisper, gist, summary, the helper, the
  # recorder) down with it under `set -e`. That was a real bug: this used to be the one download
  # of the four with no `|| true`, so a single failed embedding download silently aborted
  # everything after it in the same run.
  say "downloading the embedding model into $DATA_DIR/models (first time only)"
  mkdir -p "$DATA_DIR/models"
  # transformers.js's own downloader has no curl-style resume, but it does skip re-fetching any
  # individual file already sitting in cacheDir -- so retrying the whole pipeline() call after a
  # transient failure is cheap (only the files still missing get fetched again), not a full restart.
  local attempt
  for attempt in 1 2 3; do
    if SB_MODELS="$DATA_DIR/models" node -e '
      const { pipeline, env } = require("@huggingface/transformers");
      env.cacheDir = process.env.SB_MODELS;
      pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" })
        .then((p) => p(["warmup"], { pooling: "cls", normalize: true }))
        .then(() => console.log("model ready"))
        .catch((e) => {
          // e.message alone is just "fetch failed" for a network-layer error -- the actual reason
          // (DNS failure, TLS interception, connection reset) is on e.cause, which is otherwise
          // silently dropped.
          console.error("model download failed:", e.message, e.cause ? `(cause: ${e.cause})` : "");
          process.exit(1);
        });
    '; then
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      say "retrying the embedding model download ($attempt/3 failed)"
      sleep 5
    fi
  done
  say "embedding model download failed after 3 attempts; semantic search will stay off until it succeeds (rerun setup/prepare to retry)"
}

cmd_setup() {
  require_node
  cd "$ROOT"
  say "installing dependencies"
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
  say "building"
  npm run build
  mkdir -p "$DATA_DIR/files" "$LOG_DIR"
  download_model
  helper_stop
  ensure_token
  if build_helper; then write_helper_plist; fi
  build_recorder || true
  download_whisper_models
  download_gist_model
  download_summary_model
  probe_recorder
  if is_loaded; then
    say "stopping the running agent before reinstalling it"
    launchctl bootout "$DOMAIN/$LABEL" || true
    sleep 1
  fi
  write_plist
  cmd_start
  ok "setup complete. Data lives in $DATA_DIR"
}

# Everything cmd_setup does for a machine that needs binaries and models, minus the two things
# only cmd_setup itself is right for: `npm ci`/`npm run build` (the desktop app ships a
# pre-built standalone server -- see desktop/README.md -- so there is no source to build) and
# installing/starting this app's own launch agent (the desktop app owns that process directly,
# so a second, independent background copy of the server is exactly the thing it exists to not
# have). Everything else -- Homebrew's llama.cpp, the embedding/whisper/gist/summary models, the
# Swift helper and recorder, the activity token -- is identical either way, so it stays one
# function neither path duplicates.
# The fast half of `prepare`: everything the server genuinely needs before it can boot, and
# nothing else. Sub-second, no network. Split out from `prepare` so the desktop app can start the
# server -- and hand the user a working app -- in a couple of seconds instead of making them wait
# out ~6.5 GB of model downloads first. Every model and helper is already "off, not broken" when
# missing, so the app is fully usable while `fetch-assets` is still running behind it.
cmd_bootstrap() {
  require_node
  cd "$ROOT"
  mkdir -p "$DATA_DIR/files" "$LOG_DIR"
  ensure_token
  ok "bootstrap complete. Data lives in $DATA_DIR"
}

# The slow half: models, Homebrew's llama.cpp, the Swift helper and recorder. Safe to run while
# the server is already up -- nothing here touches the database, and each step independently
# degrades to "that feature stays off" rather than failing the run.
cmd_fetch_assets() {
  require_node
  cd "$ROOT"
  download_model
  helper_stop
  if build_helper; then write_helper_plist; fi
  build_recorder || true
  download_whisper_models
  download_gist_model
  download_summary_model
  probe_recorder
  # Nothing else starts it on this path. `cmd_start` is the only other caller of helper_start and
  # the desktop app never runs it -- it owns its own server process instead of the launch agent --
  # so without this the helper was stopped and rebuilt on every run and then simply left down,
  # which is to say activity tracking never actually ran under the desktop app at all. Safe
  # unconditionally: helper_start no-ops when the helper isn't installed (no swift, no plist).
  helper_start
  ok "assets complete. Data lives in $DATA_DIR"
}

cmd_prepare() {
  cmd_bootstrap
  cmd_fetch_assets
  ok "prepare complete. Data lives in $DATA_DIR"
}

cmd_start() {
  local open_browser=1
  [ "${1:-}" = "--no-open" ] && open_browser=0
  [ -f "$PLIST" ] || fail "launch agent not installed. Run: scripts/brain.sh setup"
  [ -d "$ROOT/.next" ] || fail "no build found. Run: scripts/brain.sh restart --build"
  local holder
  if is_loaded; then
    say "agent already loaded"
  else
    # Checked before bootstrapping, not after: once the agent is up it holds the port itself, so
    # anything listening at this point is something else, and launchd cannot win a port it does
    # not own -- it just exits 1 and retries, forever and quietly.
    holder=$(port_holder)
    if [ -n "$holder" ]; then
      fail "port $PORT is already in use by PID $holder ($(ps -o comm= -p "$holder" 2>/dev/null || true)), which is not this agent. Stop it first: kill $holder"
    fi
    launchctl bootstrap "$DOMAIN" "$PLIST"
    ok "agent loaded"
  fi
  say "waiting for $URL"
  if wait_for_server; then
    ok "server is up at $URL"
    helper_start
    if [ "$open_browser" = 1 ] && command -v open >/dev/null; then open "$URL"; fi
  else
    holder=$(port_holder)
    # `[ -n "$holder" ] && say ...` would abort here under `set -e` whenever the port is free,
    # swallowing the very diagnostics this branch exists to print.
    if [ -n "$holder" ]; then say "PID $holder is listening on $PORT but not answering"; fi
    local code; code=$(last_exit)
    say "agent's last spawn exited with ${code:-an unknown code}"
    fail "server did not answer within 60 s. Check: scripts/brain.sh logs"
  fi
}

cmd_stop() {
  helper_stop
  if is_loaded; then
    launchctl bootout "$DOMAIN/$LABEL"
    # bootout returns before the service is fully removed; wait so a following start can bootstrap.
    local i
    for i in $(seq 1 20); do
      if ! is_loaded; then break; fi
      sleep 0.5
    done
    is_loaded && fail "agent did not unload. Try: launchctl bootout $DOMAIN/$LABEL"
    ok "agent stopped"
  else
    say "agent is not loaded"
  fi
}

# Rebuilds both Swift helpers and puts the binaries where the launch agents expect them.
# The activity helper's agent is written again in case the paths in it changed.
build_helpers() {
  if build_helper; then write_helper_plist; fi
  build_recorder || true
}

cmd_restart() {
  local build=0 helpers=0 arg
  for arg in "$@"; do
    case "$arg" in
      --build)   build=1 ;;
      --helpers) helpers=1 ;;
      *) fail "unknown option: $arg (use --build and/or --helpers)" ;;
    esac
  done
  cmd_stop
  if [ "$build" = 1 ]; then
    require_node
    cd "$ROOT"
    say "rebuilding"
    npm run build
  fi
  if [ "$helpers" = 1 ]; then build_helpers; fi
  cmd_start --no-open
}

cmd_helpers() {
  helper_stop
  build_helpers
  helper_start
  probe_recorder
}

# Everything setup does for code that changed, without touching the app's launch agent.
cmd_update() {
  require_node
  cd "$ROOT"
  say "installing dependencies"
  if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
  cmd_stop
  say "building"
  npm run build
  mkdir -p "$DATA_DIR/files" "$LOG_DIR"
  download_model
  ensure_token
  build_helpers
  download_whisper_models
  download_gist_model
  download_summary_model
  cmd_start --no-open
  ok "update complete"
}

cmd_open() {
  is_up || fail "server not answering at $URL. Run: scripts/brain.sh start"
  open "$URL"
}

cmd_status() {
  if is_loaded; then
    local pid
    pid="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '/pid = /{print $3; exit}')"
    ok "agent loaded${pid:+ (pid $pid)}"
  else
    say "agent not loaded"
  fi
  if is_up; then ok "server answering at $URL"; else say "server not answering at $URL"; fi
  say "data: $DATA_DIR"
  say "log:  $LOG_FILE"
  tool_line "recorder" "$RECORDER_BIN"
  tool_line "whisper" "$(tool_path whisper-cli || true)"
  tool_line "ffmpeg" "$(tool_path ffmpeg || true)"
  tool_line "llama-cli" "$(tool_path llama-cli || true)"
  if [ -s "$DATA_DIR/models/gist/model.gguf" ]; then ok "gist model: ok"; else say "gist model: missing"; fi
  if [ -s "$DATA_DIR/models/summary/model.gguf" ]; then ok "summary model: ok"; else say "summary model: missing"; fi
  helper_status
}

cmd_logs() {
  [ -f "$LOG_FILE" ] || fail "no log yet at $LOG_FILE"
  tail -n 50 -f "$LOG_FILE"
}

cmd_dev() {
  require_node
  cd "$ROOT"
  exec npm run dev
}

cmd_backup() {
  require_node
  cd "$ROOT"
  say "taking a backup"
  SB_DATA_DIR="$DATA_DIR" npx tsx src/scripts/take-backup.ts
  ok "backup complete"
}

cmd_verify() {
  require_node
  cd "$ROOT"
  SB_DATA_DIR="$DATA_DIR" npx tsx src/scripts/verify-backups.ts
}

cmd_audio_status() {
  require_node
  cd "$ROOT"
  SB_DATA_DIR="$DATA_DIR" npx tsx src/scripts/audio-status.ts
}

cmd_release_audio() {
  require_node
  cd "$ROOT"
  say "releasing audio past the retention window"
  SB_DATA_DIR="$DATA_DIR" npx tsx src/scripts/release-audio.ts
  ok "done"
}

# Moves the whole data directory to a new location, points both plists at it, and restarts --
# the reconfigure path `setup`/`update` never offered: those only ever read SB_DATA_DIR once, at
# install time, and bake it into the plists, so the only way to move it before this existed was
# a full reinstall with the new value, or hand-editing both plist files and moving the data
# yourself. Requires an existing installation (a plist already on disk) rather than handling a
# from-scratch setup too -- that path already exists (`SB_DATA_DIR=<path> scripts/brain.sh
# setup`) and duplicating its install/build/download work here would just be a second way to do
# the same thing, with more chances to drift from it.
cmd_set_data_dir() {
  local new_dir="${1:-}"
  [ -n "$new_dir" ] || fail "usage: scripts/brain.sh set-data-dir <path>"
  case "$new_dir" in
    /*) : ;;
    *) new_dir="$(pwd)/$new_dir" ;;
  esac
  # This checkout is also the live production directory (AGENTS.md); the data it serves -- notes,
  # meeting transcripts, an activity log -- never belongs inside it, whatever .gitignore excludes.
  case "$new_dir" in
    "$ROOT"|"$ROOT"/*) fail "refusing: $new_dir is inside the code repo ($ROOT). Choose a path outside it." ;;
  esac
  [ -f "$PLIST" ] || fail "no launch agent installed yet. For a first setup, run: SB_DATA_DIR=$new_dir scripts/brain.sh setup"
  local old_dir="$DATA_DIR"
  [ "$new_dir" = "$old_dir" ] && fail "already the data directory: $new_dir"
  [ -e "$new_dir" ] && fail "refusing: $new_dir already exists. Choose a path that does not exist yet, or move it out of the way first."

  say "stopping the server before moving anything"
  cmd_stop

  # Recorded, not inferred, the same discipline cmd_restore's own db_moved uses: `moved` is the
  # one thing that decides which directory the failure trap below restarts against -- set the
  # instant the move itself succeeds, never re-derived later by asking the filesystem what's
  # where. Without this, a failure after a successful move (writing the plist, say) would restart
  # the server pointed at $old_dir, which the mv just emptied out from under it.
  local moved=0 restarted=0
  set_data_dir_failed() {
    local ec=$?
    set +e
    if [ "$restarted" != 1 ]; then
      say "set-data-dir did not finish; restarting the server so it isn't left down"
      if [ "$moved" = 1 ]; then set_data_dir_vars "$new_dir"; else set_data_dir_vars "$old_dir"; fi
      write_plist
      [ -f "$HELPER_PLIST" ] && write_helper_plist
      cmd_start --no-open
    fi
    exit "$ec"
  }
  trap set_data_dir_failed EXIT

  mkdir -p "$(dirname "$new_dir")"
  if [ -d "$old_dir" ]; then
    say "moving $old_dir to $new_dir"
    mv "$old_dir" "$new_dir"
    moved=1
    ok "data moved to $new_dir"
  else
    mkdir -p "$new_dir"
    moved=1
    say "nothing at $old_dir yet; created $new_dir fresh"
  fi

  set_data_dir_vars "$new_dir"
  write_plist
  [ -f "$HELPER_PLIST" ] && write_helper_plist
  cmd_start --no-open
  restarted=1

  trap - EXIT
  ok "data directory is now $new_dir"
}

# Resolves $1 (a bare filename or an absolute path) against the backups directory and refuses
# anything that would land outside it -- an absolute path elsewhere, a `../` escape, or a symlink
# that points outside (realpath resolves it before the prefix check, so a link inside the
# directory cannot be used to read anything beyond it). Nothing has been touched by the time this
# returns; it only decides what "the file" in `restore <file>` actually names.
resolve_backup_file() {
  local name="$1" dir="$2" dir_real candidate resolved
  [ -d "$dir" ] || fail "no backups directory at $dir"
  dir_real="$(cd "$dir" && pwd -P)"
  case "$name" in
    /*) candidate="$name" ;;
    *)  candidate="$dir_real/$name" ;;
  esac
  resolved="$(realpath "$candidate" 2>/dev/null)" || fail "no such backup: $name"
  case "$resolved" in
    "$dir_real"/*) ;;
    *) fail "refusing: $name is outside the backups directory ($dir_real)" ;;
  esac
  [ -f "$resolved" ] || fail "no such backup: $resolved"
  printf '%s\n' "$resolved"
}

# Moves $1 (a database file) and any -wal/-shm beside it to $2, as a full set, unconditionally --
# never gated on whether the base file itself exists. A crash can leave sidecars with no base (the
# exact state that sends someone to `restore` in the first place); a version of this that only
# moved the sidecars when the base was also present left a foreign -wal sitting beside whatever
# was copied in next. Refuses outright if anything already sits at $2 or its sidecars, rather than
# silently overwriting a previous replaced database -- two restores landing in the same instant
# must not collide. Echoes 1 if anything was moved, 0 if there was nothing at $1 to move.
move_db_aside() {
  local src="$1" dest="$2" suffix moved=0
  for suffix in "" "-wal" "-shm"; do
    [ -e "$dest$suffix" ] && fail "refusing: $dest$suffix already exists; wait a moment and try again"
  done
  for suffix in "" "-wal" "-shm"; do
    if [ -f "$src$suffix" ]; then
      mv "$src$suffix" "$dest$suffix"
      moved=1
    fi
  done
  echo "$moved"
}

# Copies $1 (a database file) and any -wal/-shm beside it to $2, as a set, never the base alone --
# a base copied without its -wal can silently drop rows that are still only in the log (design
# §1's own trap, and exactly what `brain-replaced-*.db` looks like right after step 4 makes one:
# `verifyDatabaseFile` at step 2 already verifies it together with its -wal, so installing the
# base alone here would put back something different from what was just pronounced sound). Clears
# $2's own -wal/-shm first, so a stale sidecar left over from whatever previously occupied $2 can
# never survive beside a $1 that has none of its own.
copy_db_set() {
  local src="$1" dest="$2"
  rm -f "$dest-wal" "$dest-shm"
  cp "$src" "$dest"
  [ -f "$src-wal" ] && cp "$src-wal" "$dest-wal"
  [ -f "$src-shm" ] && cp "$src-shm" "$dest-shm"
  return 0
}

# Restores $2/attachments-$1 over $3/attachments when that dated backup exists -- moving any
# current attachments aside first, to $3/attachments-replaced-$4, never deleting them (the rule
# for this whole procedure is move, never delete, and it applies here exactly as it applies to the
# database). The replaced directory goes in the *data* directory, beside the live one, never in
# the backups directory: the nightly job's own attachments prune (`ATTACHMENTS_NAME_RE` in
# `jobs/handlers/backup.ts`) owns every `attachments-*` name in the backups directory, and a
# `attachments-replaced-<stamp>` sitting there sorted ahead of every real dated backup and got the
# genuine ones deleted around it instead (N2) -- putting it somewhere that prune never looks is the
# fix, not a smarter name. Does nothing at all, silently, when $1 is empty or there is no matching
# dated backup -- the caller reports that. Echoes the path attachments were moved to, or nothing if
# there were none to move -- this echoed value, not a later filesystem check, is what the caller
# must treat as the record of whether anything happened.
restore_attachments_for_date() {
  local date_part="$1" backups_dir="$2" data_dir="$3" stamp="$4" src dest_replaced
  [ -z "$date_part" ] && return 0
  src="$backups_dir/attachments-$date_part"
  [ -d "$src" ] || return 0
  if [ -d "$data_dir/attachments" ]; then
    dest_replaced="$data_dir/attachments-replaced-$stamp"
    [ -e "$dest_replaced" ] && fail "refusing: $dest_replaced already exists; wait a moment and try again"
    mv "$data_dir/attachments" "$dest_replaced"
    echo "$dest_replaced"
  fi
  cp -R "$src" "$data_dir/attachments"
}

# Puts $2 (and any of its sidecars) back at $1 -- but only when $3 is exactly "1", the *recorded*
# result `move_db_aside` echoed when it actually moved something there. Never asks the filesystem
# "does something exist at $2" to decide whether to act: a file happening to sit at $2 -- most
# concretely, the very collision that made `move_db_aside` refuse and return without moving
# anything at all -- is not evidence that this run put it there, and pulling it over a live
# database that was never touched is exactly the bug this function exists to make impossible (N1).
# Prints nothing and echoes "ok" as a pure no-op when $3 is not "1". When it is, echoes "ok" if the
# move-back completed, or "failed" if it could not (rare: a second failure during recovery itself)
# -- the caller reports either outcome; this function never does.
rollback_db_if_moved() {
  local db_file="$1" replaced_path="$2" moved="$3"
  if [ "$moved" != 1 ]; then
    echo ok
    return 0
  fi
  rm -f "$db_file" "$db_file-wal" "$db_file-shm"
  if ! mv "$replaced_path" "$db_file"; then
    echo failed
    return 0
  fi
  if [ -f "$replaced_path-wal" ] && ! mv "$replaced_path-wal" "$db_file-wal"; then
    echo failed
    return 0
  fi
  if [ -f "$replaced_path-shm" ] && ! mv "$replaced_path-shm" "$db_file-shm"; then
    echo failed
    return 0
  fi
  echo ok
}

# The same recorded-state discipline as `rollback_db_if_moved`, for attachments: acts only when $3
# is exactly the path `restore_attachments_for_date` echoed (non-empty), never on whether a
# directory happens to exist at $2.
rollback_attachments_if_moved() {
  local data_dir="$1" replaced_path="$2"
  if [ -z "$replaced_path" ]; then
    echo ok
    return 0
  fi
  rm -rf "$data_dir/attachments"
  if mv "$replaced_path" "$data_dir/attachments"; then
    echo ok
  else
    echo failed
  fi
}

# restore                 lists what is available, sound or not, and stops -- it never guesses.
# restore <file>          the full procedure, each step announced as it happens. Steps 1-3 are
#                          reversible (nothing on disk has changed yet); a typed "restore"
#                          confirmation is required before step 4, which is not -- and from that
#                          point on, any failure rolls back to the original database (and
#                          attachments, if they were touched) and restarts the server, rather than
#                          leaving the app down with half a restore on disk. The rollback acts only
#                          on what this run *recorded* having moved (`db_moved`,
#                          `attachments_moved`), never on what merely happens to exist on disk.
cmd_restore() {
  require_node
  cd "$ROOT"
  local arg="${1:-}"

  if [ -z "$arg" ]; then
    say "available backups:"
    SB_DATA_DIR="$DATA_DIR" npx tsx src/scripts/verify-backups.ts || true
    say "restore <file> to restore one of these"
    return 0
  fi

  # Must come before anything is stopped: `read` at EOF (a non-interactive invocation, a closed
  # stdin over ssh) returns non-zero under `set -e` and would otherwise abort mid-procedure with
  # the server already down and nothing printed.
  [ -t 0 ] || fail "restore needs an interactive terminal to type the confirmation; refusing to run unattended"

  say "1/8 resolving $arg"
  local target
  target="$(resolve_backup_file "$arg" "$BACKUPS_DIR")"
  ok "resolved to $target"

  say "2/8 verifying it -- nothing is touched until this passes"
  SB_DATA_DIR="$DATA_DIR" npx tsx src/scripts/verify-backups.ts "$(basename "$target")" \
    || fail "backup failed verification; refusing to restore. Nothing has changed."
  ok "backup verified sound"

  # One restore at a time: a stale lock (a previous run that crashed instead of cleaning up after
  # itself) has to be removed by hand, deliberately -- this never removes one on its own. See
  # docs/superpowers/runbook.md for what to do about a stale one; a stale lock only ever blocks a
  # *new* restore from starting, never the rollback of one already in flight (the trap below
  # releases it unconditionally, on every exit, success or failure).
  local lock_dir="$DATA_DIR/.restore.lock"
  mkdir "$lock_dir" 2>/dev/null || fail "another restore appears to be in progress ($lock_dir exists) -- see docs/superpowers/runbook.md; remove it with: rmdir \"$lock_dir\", once you are sure that is not true"

  # Recorded state, not inferred: every flag below starts at 0/empty and is set to its true value
  # by the one line that performs the action it names, immediately after that action reports
  # success -- never re-derived later by asking the filesystem "does X exist". `server_stopped` is
  # what tells the rollback whether the server needs restarting at all, independently of *why*
  # this function is exiting: a non-"restore" answer, Ctrl-C at the prompt, and a failure ten lines
  # later all reach the same trap, and all three must restart the server the same way (N4) -- there
  # is exactly one place that decides "was the server stopped by this run", and it is this flag.
  local server_stopped=0 db_moved=0 db_replaced_path="" attachments_moved=0 attachments_replaced_path=""
  restore_failed() {
    local ec=$?
    set +e
    rmdir "$lock_dir" 2>/dev/null

    local db_result="ok" attachments_result="ok"
    if [ "$db_moved" = 1 ]; then
      echo
      say "restore failed partway through; putting the original database back"
      db_result="$(rollback_db_if_moved "$DB_FILE" "$db_replaced_path" "$db_moved")"
      if [ "$db_result" = ok ]; then
        say "database restored to $DB_FILE"
      else
        printf '\033[31m✗\033[0m %s\n' "could not automatically finish restoring the database." >&2
        printf '\033[31m✗\033[0m %s\n' "check both of these by hand before doing anything else: $DB_FILE and $db_replaced_path" >&2
      fi
    fi

    if [ "$attachments_moved" = 1 ]; then
      say "putting the original attachments back"
      attachments_result="$(rollback_attachments_if_moved "$DATA_DIR" "$attachments_replaced_path")"
      if [ "$attachments_result" = ok ]; then
        say "attachments restored to $DATA_DIR/attachments"
      else
        printf '\033[31m✗\033[0m %s\n' "could not automatically finish restoring attachments." >&2
        printf '\033[31m✗\033[0m %s\n' "check both of these by hand: $DATA_DIR/attachments and $attachments_replaced_path" >&2
      fi
    fi

    # Everything the owner needs to know is printed above this line, before the one call in this
    # handler that can itself exit without returning: `cmd_start`'s own failure path is `fail`,
    # which is `exit`, and an `exit` inside a running EXIT trap ends the process immediately --
    # nothing after it in this function would run. So the diagnosis comes first and the restart
    # attempt comes last, on purpose, not printed together with it.
    if [ "$server_stopped" = 1 ]; then
      say "restarting the server"
      cmd_start --no-open
    fi

    # No early return on `ec -eq 0`: a Ctrl-C at the confirmation prompt has been observed to
    # leave `$?` at 0 even though nothing this function did completed normally, and by the time
    # this trap runs at all `trap - EXIT` has already disabled it on the one path where nothing
    # here needs to run (step 8's clean success) -- so reaching this line at all means something
    # was interrupted, whatever `$ec` says, and the flags below (not `$ec`) decide what to report.
    if [ "$db_moved" = 1 ] && [ "$db_result" != ok ]; then
      fail "restore failed and could not be fully rolled back automatically -- see above for exactly where things are"
    elif [ "$db_moved" = 1 ]; then
      fail "restore failed and was rolled back; the original database is back at $DB_FILE"
    else
      fail "restore did not proceed; nothing on disk has changed"
    fi
  }
  trap restore_failed EXIT

  say "3/8 stopping the server"
  cmd_stop
  is_up && fail "server is still answering; refusing to continue"
  server_stopped=1
  ok "server is down"

  echo
  echo "This will move the current database aside and replace it with:"
  echo "  $target"
  printf 'Type "restore" to continue, anything else (or Ctrl-C) to stop here: '
  local confirm=""
  read -r confirm || true
  [ "$confirm" = "restore" ] || fail "confirmation not given; restore cancelled"

  say "4/8 moving the current database aside"
  mkdir -p "$BACKUPS_DIR"
  local stamp moved_db
  stamp="$(node -e 'process.stdout.write(new Date().toISOString().replace(/[:.]/g, "-"))')"
  db_replaced_path="$BACKUPS_DIR/brain-replaced-$stamp.db"
  moved_db="$(move_db_aside "$DB_FILE" "$db_replaced_path")"
  # Reached only if the line above did not refuse (refusing exits the whole function via `set -e`
  # before this assignment, leaving db_moved at its safe initial 0) -- see rollback_db_if_moved.
  db_moved="$moved_db"
  if [ "$db_moved" = 1 ]; then
    ok "current database (and any sidecars) moved to $db_replaced_path"
  else
    say "no current database or sidecars at $DB_FILE; nothing to move aside"
  fi

  say "5/8 copying the backup into place"
  copy_db_set "$target" "$DB_FILE"
  ok "backup (and any sidecars) copied to $DB_FILE"

  say "6/8 restoring attachments for that date"
  local base date_part
  base="$(basename "$target")"
  date_part=""
  if [[ "$base" =~ ^brain-([0-9]{4}-[0-9]{2}-[0-9]{2})\.db$ ]]; then
    date_part="${BASH_REMATCH[1]}"
  fi
  if [ -n "$date_part" ] && [ -d "$BACKUPS_DIR/attachments-$date_part" ]; then
    attachments_replaced_path="$(restore_attachments_for_date "$date_part" "$BACKUPS_DIR" "$DATA_DIR" "$stamp")"
    if [ -n "$attachments_replaced_path" ]; then
      attachments_moved=1
      ok "attachments restored from attachments-$date_part; the previous ones are at $attachments_replaced_path"
    else
      ok "attachments restored from attachments-$date_part (there were none before)"
    fi
  else
    say "no attachments backup for that date; current attachments left as they are, unchanged"
  fi

  say "7/8 starting the server"
  local log_offset=0
  [ -f "$LOG_FILE" ] && log_offset="$(wc -l < "$LOG_FILE" | tr -d ' ')"
  cmd_start --no-open
  local boot_line=""
  [ -f "$LOG_FILE" ] && boot_line="$(tail -n "+$((log_offset + 1))" "$LOG_FILE" | grep "database integrity check" | tail -1 || true)"
  if [ -n "$boot_line" ]; then
    say "boot check: $boot_line"
  else
    say "boot check: no result yet from this restart in $LOG_FILE"
  fi

  say "8/8 done"
  trap - EXIT
  rmdir "$lock_dir" 2>/dev/null || true
  if [ "$db_moved" = 1 ]; then
    ok "the replaced database is at: $db_replaced_path"
  else
    ok "restore complete (there was no previous database to keep)"
  fi
}

case "${1:-}" in
  setup)   cmd_setup ;;
  update)  cmd_update ;;
  helpers) cmd_helpers ;;
  open)    cmd_open ;;
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) shift; cmd_restart "$@" ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
  dev)     cmd_dev ;;
  backup)  cmd_backup ;;
  verify)  cmd_verify ;;
  audio-status)   cmd_audio_status ;;
  release-audio)  cmd_release_audio ;;
  restore) shift; cmd_restore "$@" ;;
  set-data-dir) shift; cmd_set_data_dir "$@" ;;
  prepare) cmd_prepare ;;
  bootstrap) cmd_bootstrap ;;
  fetch-assets) cmd_fetch_assets ;;
  -h|--help|help|"") usage ;;
  *) usage; fail "unknown command: $1" ;;
esac
