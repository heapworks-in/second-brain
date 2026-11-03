# Second Brain (desktop)

A Tauri shell around the app in `..`, for people you share this with who should never see a
terminal. It is not a rewrite: the actual product is the same Next.js app, the same SQLite
database, the same `scripts/brain.sh` logic that already installs and downloads everything for
the CLI-managed install — this just owns the whole thing as one process instead.

## What it does

1. **Bundles a pre-built server**, not source. `npm run build` (with `output: "standalone"` in
   `next.config.ts`) produces `.next/standalone/`, a self-contained copy of the server plus only
   the `node_modules` it actually needs. That's what ships inside the app — a recipient's machine
   never runs `npm ci` or `npm run build`.
2. **On first launch**, extracts that bundle to
   `~/Library/Application Support/com.second-brain.desktop/current/` (code — deliberately not the
   data directory, the same separation `scripts/brain.sh set-data-dir` enforces for the
   CLI-managed install), then runs `scripts/brain.sh prepare` from there — Homebrew's `llama.cpp`,
   every model, the Swift helper and recorder. Progress streams into the window live; nothing
   silently sits on a blank screen.
3. **Owns the server directly.** Once prepared, it spawns `node server.js` as its own child
   process (not through launchd, not detached) and loads `http://127.0.0.1:3141` in the window.
   Quitting from the tray kills that process; there is no second, independent background service
   this app doesn't control.
4. **Lives in the menu bar.** Closing the window hides it rather than quitting — the server (and
   activity tracking / auto-recording, once running) keeps going, same always-on behaviour the
   CLI-managed launchd install already has, just owned by this one process tree instead of a
   separate one. The tray menu has **Open Second Brain** and **Quit**. It also registers itself as
   a login item, so it comes back after a restart the same way the launchd agent does.

## Known limits (today's build)

- **Node 22+ must already be on the recipient's Mac.** The bundle ships the *built* server, not a
  Node runtime — `node server.js` still needs a real `node` on `PATH`. The Homebrew cask declares
  `node` (along with `llama.cpp`, `whisper-cpp` and `ffmpeg`), so a brew install has it; a dmg
  opened by hand does not. Bundling Node itself is a reasonable next step, not done here.
- **Apple Silicon only.** `better-sqlite3`, `onnxruntime-node`, and the bundled `llama-cli`/model
  files are all arm64. An Intel build would need its own `npm run build` and its own Tauri
  bundle target.
- **Unsigned.** No Apple Developer account is wired into this build, so macOS Gatekeeper will
  warn on first open. Right-click → Open bypasses it on most Macs. If a Mac's "Allow apps from"
  setting is locked to the App Store, that doesn't work at all and there's no "Open Anyway" button
  to fall back on — the reliable fix on any Mac, regardless of that setting, is to strip the
  quarantine flag after installing:
  ```sh
  xattr -cr "/Applications/Second Brain.app"
  ```
  Real signing + notarization is a separate, later step that would remove the need for this.
- **Models download on first launch**, not bundled — the summary model alone is ~4.4 GB, and
  GitHub's own release-asset size limit (2 GB per file) rules out bundling everything anyway. A
  first run needs real time and a real internet connection.
- **Activity tracking / meeting recording need Xcode Command Line Tools** (for `swift build`),
  exactly like the CLI-managed install — `scripts/brain.sh prepare` already skips them gracefully
  and says so if CLT isn't present, rather than failing setup outright.

## Permissions

macOS only prompts for microphone, calendar and automation access when the app asking has a
usage-description string for it in its `Info.plist`. Without one it does not show a dialog and
quietly denies instead -- which is how meeting recording came to fail with no prompt and no
visible reason. `src-tauri/Info.plist` carries those strings and Tauri merges them into the built
app; the wording is what the prompt actually shows, so it says what the access is used for.

Two things this does not solve:

- **The CLI-managed install cannot prompt at all.** TCC attributes a request to the responsible
  process, which for `launchd -> next start -> sb-recorder` is no GUI app, so there is nothing to
  show a dialog on behalf of and nothing with a usage string. Run it from a terminal and the
  helper inherits *that* terminal's grants, which is why the same binary records fine by hand and
  dies instantly under the launch agent. The desktop app is the fix: it is a real bundle, so
  requests are attributed to it.
- **Accessibility is never prompted for.** macOS grants it only from System Settings. The activity
  helper can ask the system to open that pane, but the switch has to be flipped by hand.

Both Swift helpers are ad-hoc signed, so their grants are bound to the binary rather than to a
stable identity: rebuilding one silently voids whatever was granted to the previous build, and the
stale entry can still appear switched on in System Settings. Remove it with the `-` button and let
it re-prompt rather than toggling it off and on.

This has happened for real, and it is worth knowing how to prove rather than guess at, because the
symptom is a granted-looking switch and a helper reporting the permission as missing. `tccd` says
so outright:

```sh
/usr/bin/log show --last 10m --predicate 'process == "tccd"' | grep -i sb-activity
```

```
cdhash H"20b47a92…"; status: -67050
Failed to match existing code requirement for subject …/bin/sb-activity
    and service kTCCServiceAccessibility
AUTHREQ_RESULT: authValue=0, authReason=5
```

The pinned cdhash is the build that was granted; `codesign -dvvv "$HELPER_BIN"` prints the one on
disk now, and they differ after any rebuild. Note `/usr/bin/log` rather than `log`, which is
shadowed by a shell function in some setups. The line is only logged when the helper *first* asks,
so it is usually absent by the time you look -- which is why `scripts/brain.sh status` explains the
rebuild date instead of trying to find it. Accessibility is the one grant that cannot recover by
itself: it never prompts, so unlike calendar and automation it cannot be re-granted by answering a
dialog after the rebuild.

## Troubleshooting

If the app shows an error (during setup or once it's running), the full log — `prepare`'s output,
line by line, and the Next.js server's own stdout/stderr — is at:

```
~/Library/Logs/com.second-brain.desktop/Second Brain.log
```

### A model download keeps failing

Each model download is skip-if-present: `prepare` only fetches a model if the exact file isn't
already there, so you can download one yourself (a browser succeeds in plenty of cases where the
app's own `fetch`/`curl` doesn't — a flaky connection, a proxy, a firewall) and drop it into place
by hand. Quit the app first, then place these under
`~/Library/Application Support/second-brain/models/` with the exact relative paths below, and
relaunch:

| What | Exact path | Source URL |
|---|---|---|
| Whisper (small, faster) | `whisper/ggml-base.en.bin` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin` |
| Whisper (larger, better) | `whisper/ggml-medium.en.bin` | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin` |
| Gist model | `gist/model.gguf` | `https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf` |
| Summary model | `summary/model.gguf` | `https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf` |
| Embedding — config | `Xenova/bge-small-en-v1.5/config.json` | `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/config.json` |
| Embedding — tokenizer | `Xenova/bge-small-en-v1.5/tokenizer.json` | `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer.json` |
| Embedding — tokenizer config | `Xenova/bge-small-en-v1.5/tokenizer_config.json` | `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/tokenizer_config.json` |
| Embedding — model | `Xenova/bge-small-en-v1.5/onnx/model.onnx` | `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model.onnx` |
| Embedding — model (quantized) | `Xenova/bge-small-en-v1.5/onnx/model_quantized.onnx` | `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx` |

If you already have a whisper model from somewhere else, just rename/copy it to the exact filename
above — the filename is all that's checked.

## Building it

```sh
cd ..                                   # repo root
npm run build                           # produces .next/standalone/ (output: "standalone")
cp -r .next/static .next/standalone/.next/
cp scripts/brain.sh .next/standalone/scripts/brain.sh
rm -rf .next/standalone/helper
mkdir -p .next/standalone/helper
rsync -a --exclude='.build' helper/ .next/standalone/helper/
rm -rf .next/standalone/desktop           # see note below -- not optional
node desktop/scripts/bundle-externals.mjs # see note below -- not optional

cd desktop
cargo tauri build                       # .app + .dmg under src-tauri/target/release/bundle/

cd .. && ./desktop/scripts/smoke-test.sh  # REQUIRED before publishing
```

**Run `smoke-test.sh` before every release.** It extracts the built `.app`'s payload to a directory
outside the repo and uses it there: loads every externalized package, builds both Swift helpers from
the bundled source, runs `bootstrap`, and boots the server to serve real routes. Testing inside the
repo is what let three separate bugs reach users — Node resolves `require()` upward into the repo's
own `node_modules`, so packages entirely missing from the bundle still loaded locally, and
`swift build` passed against `helper/` in the repo while the bundled copy had no `Package.swift`.
The script exists because "it works on my machine" was structurally guaranteed here.

`bundle-externals.mjs` is equally not optional. Turbopack doesn't bundle `serverExternalPackages`
(that's the point of them) and its tracer copies them incompletely — it followed the ESM graph and
skipped the CJS entry points that `require()` actually resolves to, so `linkedom` and `sqlite-vec`
shipped as present-but-unusable directories. It also rewrites externals to content-hashed aliases
(`better-sqlite3-90e2652d1716b047`) resolved through `.next/node_modules/`, where each alias is a
**symlink to a directory** — which Tauri's bundler drops entirely and the app's install-time copy
cannot copy. The script copies each external plus its dependency closure (including the
platform-specific `optionalDependencies` that carry native binaries, like `sqlite-vec-darwin-arm64`)
and replaces those alias symlinks with real directories.

The `rm -rf .next/standalone/desktop` step is required, not cleanup. `next build` defaults to
Turbopack, whose file tracer swept this entire directory (including `src-tauri/target/`, a
multi-GB Rust build directory) into the standalone bundle wholesale -- `outputFileTracingExcludes`
in `next.config.ts` correctly filters the `.nft.json` trace files themselves (verifiable after a
build), but the actual standalone copy step doesn't consult that filtered result for Turbopack
builds, so the exclude is effectively a no-op here despite looking like it worked. Confirmed by
directly deleting the directory after a build and it not reappearing on its own -- it's a one-time
copy during `next build`, not a live process, so removing it after every build is safe and
sufficient. Ballooned a release from ~120MB to over 5GB before this was caught.

The `helper/` copy above exists for the same reason in reverse: the tracer includes only some of
`helper/`'s files (never `Package.swift`), so a build relying on the tracer alone ships a broken,
partial copy that fails `swift build` with "could not find Package.swift in this directory or any
of its parent". Copying it explicitly and completely, the same way `public/` and `.next/static`
already are, sidesteps the tracer for a directory it was never meant to reason about in the first
place -- it isn't part of the server's module graph at all.

`tauri.conf.json`'s `bundle.resources` maps `../../.next/standalone/` to `server/` inside the app
bundle — `ensure_code_installed` in `src-tauri/src/lib.rs` is what extracts it on first run, and
`.version` next to the extracted copy is what tells a later launch whether it needs to happen
again after an update.

## Releasing

The cask is a second place the version lives, and brew users stay on the old build until it moves.

```sh
# after the build above, with the smoke test passed and the version bumped in
# src-tauri/tauri.conf.json and src-tauri/Cargo.toml
V=0.5.3
DMG="desktop/src-tauri/target/release/bundle/dmg/Second Brain_${V}_aarch64.dmg"

gh release create "desktop-v$V" --repo heapworks-in/second-brain --target master \
  --title "..." --notes-file notes.md "$DMG#Second.Brain_${V}_aarch64.dmg"

# bump the cask: version, sha256
shasum -a 256 "$DMG"
cd "$(brew --repo heapworks-in/tap)" && $EDITOR Casks/second-brain.rb
brew style --cask Casks/second-brain.rb     # stanza order is enforced; --fix corrects it
brew fetch --cask heapworks-in/tap/second-brain   # proves the url and the sha256
brew livecheck --cask heapworks-in/tap/second-brain
git commit -am "second-brain: $V" && git push
```

**Check the payload before publishing.** The release is public and ships the whole
`.next/standalone/` tree, so anything personal that reached it is published with it:

```sh
find "desktop/src-tauri/target/release/bundle/macos/Second Brain.app/Contents/Resources/server" \
  -name '*.json' -path '*programs*'      # expect only example.json
```

Homebrew refuses casks from a tap it does not know, so the install is three commands rather than
two — `brew tap`, `brew trust heapworks-in/tap`, then `brew install --cask second-brain`.

## Where things live

- `src-tauri/src/lib.rs` — everything: resource extraction, `brain.sh prepare`, spawning and
  owning the server process, the tray, the window-hide-not-quit behaviour, autostart.
- `dist/index.html` — the loading screen shown while `prepare` and the server start up. Plain
  HTML/JS on purpose (no bundler): `app.withGlobalTauri` in `tauri.conf.json` exposes
  `window.__TAURI__` directly rather than needing `@tauri-apps/api` resolved through a build step.
  It calls the `frontend_ready` command the instant its `listen()` calls are registered — Rust
  waits for that handshake before emitting anything, rather than emitting on a timer and hoping
  the page has loaded by then (an event emitted before a listener exists is simply lost, not
  queued).
