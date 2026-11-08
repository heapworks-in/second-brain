# Settings, and model execution in one place — design

Date: 2026-11-09. One page where every setting can be read and changed, and one file outside this app that says which local model plays which role, so other applications can read the same answer.

## 1. Purpose

Two problems that turn out to be one.

**Settings are in four places and none of them is called settings.** The calendar feed sits behind a gear in the Planner, audio retention in the Meetings header, the focus rhythm in the focus pane, working hours on a chip on the capacity line. Nothing lists them. A setting you cannot find is a setting you cannot change, and there is no answer to "what is this app configured to do".

**Setup has no surface at all.** Every model download, helper install and permission grant happens in `scripts/brain.sh setup`. A packaged app whose only configuration path is a shell script in a repo is not a packaged app. Worse, each of these fails independently and quietly: `ensure_llama_cli` gives up with a log line on a Mac without Homebrew while `fetch_model` still downloads 4.4 GB beside it, which leaves `hasSummaryModel()` true, `getChatProvider()` null, and a summary job that completes having done nothing.

The connecting idea is that **the app should be able to say what state it is in and offer the next action**, for every dependency and every setting, on one page. Two rules carry that:

- **Nothing is a dead end.** Every row that reports a state also offers the action that changes it. Where the app cannot act itself — a Homebrew install, a macOS permission — it shows the exact command to copy or opens the right System Settings pane. "Not installed" is never the whole message.
- **Everything states its inverse.** Every row that changes something says how to change it back, on the same row, before it is pressed. A download says it can be removed; a removal says it can be downloaded again, and what that costs.

## 2. The model roles file

`~/.config/local-models.json`, read and written by the Models section. **Deliberately not the `settings` table**, which is the opposite of how every other setting in this app works: the entire point is that other applications can read it, and a row in second-brain's SQLite is unreachable by them.

```json
{
  "runtime": { "kind": "ollama", "url": "http://127.0.0.1:11434" },
  "roles": {
    "summary": { "model": "gemma4:26b" },
    "gist": { "model": "gemma4:12b-it-qat" }
  }
}
```

Roles, not model names, in application code. An app asks for "the summariser"; the file decides what that is today. Swapping a model is one line, no rebuild, and every application that reads the file follows.

**Resolution order per role**, which the page shows for each one:

1. the file, if it names the role and the runtime has that model
2. ollama on its default port, if it answers and holds exactly one plausible model
3. today's behaviour — the GGUF under `$DATA_DIR/models/<role>/model.gguf` plus a `llama-cli` found on `PATH`

Three sources because the dmg must work on a machine with no file, no ollama and no Homebrew. `getChatProvider()` returning null already means "this feature is off, not broken"; that stays.

**Reversibility.** A write copies the previous file to `local-models.json.bak` first, and the section offers Revert while a backup exists. One level, not a history: this is a file with four lines in it, and a person who wants the version from three weeks ago wants their own backups, not ours.

### Out of scope, with reasons

- **Embeddings stay on `Xenova/all-MiniLM`.** Its vectors are already in sqlite-vec at a fixed dimension; changing the model silently invalidates every chunk in the database. The row appears, locked, with that sentence on it — a setting that destroys your search index should not be one click.
- **Transcription stays a binary plus a model file.** ollama serves chat and embeddings, not ASR. The Models section lists it as its own kind of row rather than pretending one abstraction covers both.
- **No remote providers.** The `ChatProvider` interface would take one, and adding the field here would make a key the obvious next step. Local only in this slice.

## 3. The page

`/settings`, its own page, `g ,` in the dock's tools section. Sections, in this order, because it descends from "is this thing working" to "how do I like it":

1. **Setup** — every dependency, its state, its cost and its action.
2. **Models** — the roles file above.
3. **Meetings** — auto-record, audio retention. Moves here from the Meetings header.
4. **Calendar** — the published feed URL. Moves here from the Planner gear.
5. **Planner** — working hours, working days.
6. **Focus** — rhythm, lengths, break lengths.
7. **Data** — where the database is, last backup, recovery points, the integrity check's last result.

Each section is read from and written to **the route that already owns it** (`/api/settings/meetings`, `/api/settings/focus`, `/api/settings/planner`, `/api/settings/calendar`). No new store, no copies, so the page and the in-place controls cannot disagree.

**What does not move.** The working-hours chip on the capacity line and the rhythm switch in the focus pane stay where they are. They are controls used while working, not configuration: making someone leave the Planner to change the hours the Planner is drawing would be a regression. They write the same routes, so both surfaces show one truth. The Planner's calendar gear and the Meetings header's retention control do move out — those are configuration that had nowhere else to live.

**Each section has Reset to defaults**, and the default is named on screen rather than implied, because a reset you cannot predict is one nobody presses.

## 4. The Setup section

One row per dependency. Columns are state, cost, action — and the action is never absent.

| row | state comes from | action |
|---|---|---|
| ollama | `GET /api/version` on its port | reachable, or the command to install and start it |
| llama.cpp (`llama-cli`) | `resolveTool` | present, or `brew install llama.cpp` to copy |
| Summary model | `hasSummaryModel()` | Download (4.4 GB) / Remove — and "Download again" once removed |
| Gist model | `hasGistModel()` | the same pair |
| Whisper models | `whisperModelsDir()` | the same pair, per model |
| Recorder helper | `recorderBin()` | Install, which is what `brain.sh setup` does today |
| Activity helper | `/api/activity/status` | Install, start, or the reason it is down |
| Microphone | `microphoneAccess()` | Open System Settings at that pane |
| Accessibility | the helper's own report | the same |
| Full Disk Access | a probe read of the notification store | the same |

Downloads run as jobs through the existing worker, so they survive a page close and report progress the way every other long task does; the row shows bytes and a Cancel. A cancelled or failed download leaves no partial file that `hasSummaryModel()` would call installed — the check is the file at its final path, so a download writes `.part` and renames on success.

**Removing a model is the reversible case worth stating twice.** The row says "Remove — 4.4 GB, can be downloaded again" before the press, and afterwards reads "Download again (4.4 GB)". Nothing about it is one-way, and nothing about it touches a model another application owns: this removes only files under `$DATA_DIR/models`, never anything in `~/.ollama`.

## 5. Testing

The roles file gets the resolution order as a table: file wins, ollama second, local third, nothing at all answers null. Writing gets the backup-then-write, the Revert, and a write refused because the runtime does not have the named model — refused before the file moves, so a bad save cannot leave a working config half-replaced.

The page gets, per section, that it reads its own route and writes its own route; that Reset writes the named defaults; and that a failed save says so and leaves the previous value on screen rather than appearing to have worked. The Setup section gets one test per row kind: present, absent-with-an-action, and mid-action.

The download job gets the `.part` rename, a cancel leaving nothing behind, and a failure leaving nothing behind.

## 6. Slice order

1. The roles file, the ollama provider, the resolution order, and the Models section. This is the new capability.
2. `/settings` with the four existing sections moved in, in-place controls left alone.
3. The Setup section, downloads as jobs.
4. The Data section.
