# Second Brain

A personal capture, search, task, and meeting system that runs locally on a Mac. Stage one covers capture (notes, links, PDFs, images), background processing, and hybrid keyword plus semantic search.

**[heapworks-in.github.io/second-brain](https://heapworks-in.github.io/second-brain/)** — what it looks like, and the manual.

## Install

    brew tap heapworks-in/tap
    brew trust heapworks-in/tap
    brew install --cask second-brain

Apple Silicon, macOS 12 or newer. The cask brings `node`, `llama.cpp`, `whisper-cpp` and `ffmpeg`
with it: the app needs all four at runtime and treats each as a feature switched off when it is
missing, so letting Homebrew put them there is the difference between a working install and one
that quietly does less. First launch downloads about 6 GB of local models and shows the progress.
Nothing is uploaded, then or later.

The [releases page](https://github.com/heapworks-in/second-brain/releases) carries the same dmg if
you would rather not use Homebrew. The build is ad-hoc signed, so a dmg opened by hand needs
right-click → Open the first time; the cask clears the quarantine flag for you.

## Run it from this checkout

    npm run setup

One command: installs dependencies, builds, downloads the embedding model, installs a launchd agent that starts the app at login and keeps it running on http://localhost:3141, and opens it. After that:

    npm run status      # agent, server, tool and helper state
    npm run update      # after pulling changes: deps, app and helper builds, models, restart
    npm run restart     # restart; add -- --build to rebuild the app, -- --helpers for the Swift helpers
    npm run stop        # stop the agent and the activity helper
    npm run logs        # tail the server log

    scripts/brain.sh helpers   # rebuild and reinstall just the activity helper and the recorder
    scripts/brain.sh open      # open the app in the browser

The script behind these is `scripts/brain.sh`.

## Run in development

    npm install
    npm run dev

Open http://localhost:3141. Stop the launch agent first (`npm run stop`) if it is running, since both use the same port. Data lives in `~/Library/Application Support/second-brain/` (override with `SB_DATA_DIR`). The first capture downloads the embedding model (about 35 MB) into the `models/` folder there.

## Run tests

    npm test

The transformers embedding test downloads the model into `~/.cache/second-brain-test-models` on first run.

## Environment

| Variable | Purpose |
|---|---|
| `SB_DATA_DIR` | Data directory. Defaults to Application Support. |
| `SB_EMBED` | Set to `off` to disable semantic search and run keyword-only. |

## Keyboard

| Keys | Action |
|---|---|
| `⌘K` | Command palette |
| `g h` `g d` `g g` `g w` `g i` `g p` `g a` `g r` `g e` `g t` `g l` `g x` `g s` `g c` | Home, Planner, Goals, Review, Inbox, Projects, Areas, Resources, People, Activity, Library, Archive, Search, Capture |
| `/` | Focus search |
| `⌘↵` | Capture |
| `⌘S` | Save item, container, or person |
| `⌘.` | Take the action the newest toast offers (Escape dismisses it) |
| `⌘⇧F` | Start a focus run on whatever task the keyboard sits on, switch it to a different one, or stop it |
| In the Inbox: `p` `a` `r` `e` `x` `j` `k` `l` | File to project / area / resource, archive, delete, next, previous, list view |

## How things are organised

PARA. Every capture lands in the Inbox. Processing the Inbox files each item into exactly one home: a **Project** (an outcome with a deadline), an **Area** (a responsibility with a standard), or a **Resource** (a topic, grouped by category). Anything inactive is **Archived**, and completing a project asks where its items should go. People are a light CRM: mention `@slug` in a note to link it to a person.

### Tasks

Tasks belong to a project or an area. Add one from the project or area page: Enter adds it, end with a day like `fri` or a date to set a due date, and start with `!` for high priority. Check tasks off, drag to reorder, and each project card shows its progress and the next open task. The old next-steps checklist was converted into tasks the first time the app started after this update.

### Links and notes

Projects, areas, and resources each have a Links section and a Notes section. Paste a URL to capture a link without leaving the page; pasting one already saved points you to the existing item instead of duplicating it. Star a link to pin it, up to three of which show as domain chips on that project's card. "New note" opens a fresh untitled note for the container. The container's own description lives behind an "About this project/area/resource" disclosure above these sections. Archived projects, areas, and resources show their links and notes too, read-only.

### Design

The interface is a carbon workspace: a floating dock, a breadcrumb bar, a context rail beside documents, and one prompt bar that captures, adds tasks, and searches from any page. One violet accent, serif titles, small mono labels. Motion is limited to state changes and respects reduced-motion settings.

### Writing

Notes use a block editor. Type `/` for blocks, markdown shortcuts work as you type, and you can paste or drop images into an item's note — containers and people have nowhere to store an image, so use a note there instead. Callouts are `> [!note]`, `> [!tip]`, and `> [!warning]` blockquotes. Footnotes are not supported; the editor escapes their brackets. Everything is stored as markdown, so search and backups see plain text.

### Distill

A background sweep checks every note, link, and file for one that has gone quiet — untouched for 30 minutes — and long enough to be worth reading twice. When it finds one, it pulls a handful of sentences straight out of the item's own text, verifies each is genuinely present rather than paraphrased, and — only once enough real quotes survive — asks a small local model to rewrite exactly those quotes as one short paragraph, the gist. Nothing is sent anywhere: the model is a single `.gguf` file `scripts/brain.sh setup` downloads, and Distill does nothing at all until that file exists.

The gist and its source quotes show up as an offer at the top of the item, never touching the item's own text — **Keep** marks the distillation permanent, and **Not useful** dismisses it for good. Either way it never runs again for that item: once decided, an item is never re-offered. A kept distillation earns a "Distilled" badge on its row in the Library, and the **Distilled** chip there filters to exactly those items — a shortcut back to whatever you've already judged worth keeping.

## Activity tracking

A Swift helper (`helper/activity`, installed by `scripts/brain.sh setup` as the launch agent `com.second-brain.activity`) samples the frontmost app every 5 seconds and posts heartbeats to the local server. It records: the frontmost app and its window title, the browser URL for Chrome, Arc, Brave, Edge, and Safari, away time once you have been idle for 3 minutes, and calendar events for today and tomorrow.

Three macOS permissions make this work, and the system asks for each on first run: **Accessibility** (to read the focused window title), **Automation** per browser (to read the active tab's URL), and **Calendars** (to read upcoming events). Nothing is recorded before a permission is granted for that data.

**Calendar**: add your Microsoft 365 account in System Settings › Internet Accounts with Calendars on; the helper reads it through EventKit.

A set of exclusions ships pre-seeded (password managers, banking apps, and similar) so their app or domain never gets recorded; add more from the Rules drawer. Pause is a chip in the page header — the helper keeps pinging the server so "last seen" stays fresh, but nothing is stored while paused. Activity data is kept for 90 days by default and pruned nightly.

To uninstall the helper: `scripts/brain.sh stop`, then `launchctl bootout gui/$(id -u)/com.second-brain.activity`, then delete `~/Library/LaunchAgents/com.second-brain.activity.plist` and `DATA_DIR/bin/sb-activity`.

## Meetings and recording

Recording needs two Homebrew tools and a Swift helper. The cask installs the tools; a checkout
needs them by hand:

    brew install whisper-cpp ffmpeg

`scripts/brain.sh setup` builds the recorder (`helper/recorder`, installed as `DATA_DIR/bin/sb-recorder`), downloads the whisper models into `DATA_DIR/models/whisper/` (`ggml-base.en.bin` for the live transcript, `ggml-medium.en.bin` for the final pass, linked instead of downloaded again when `whisper-cpp` already has it), and runs the recorder once so macOS raises its prompts. `npm run status` reports `recorder:`, `whisper:`, and `ffmpeg:`.

Two permissions matter, both asked for on that first run: **Microphone**, and on macOS 14.2 and newer **System Audio Recording** — the recorder taps the default output device so the other side of a call is captured too. Refuse the second and recording still works, microphone only. Answer them in System Settings › Privacy & Security, then re-check with:

    "$HOME/Library/Application Support/second-brain/bin/sb-recorder" --probe

Recordings are written as 16 kHz mono WAV under `DATA_DIR/files/meetings/`, alongside their transcripts; nothing is uploaded, and both whisper models run locally.

The transcript is the record; the audio is scaffolding. Once a meeting has a transcript, its
recording is deleted seven days later by default, in the same nightly pass that takes the
backup — `meetings.audioRetentionDays` (`PATCH /api/settings/meetings`) takes any number of days
from 0 (release as soon as the transcript lands) to 365, or `null` to keep every recording
forever. Audio with no transcript is never deleted, however old: if transcription failed or
never ran, that recording is the only copy of what was said, and a retention window is only ever
a promise about disposable data. A meeting page whose audio has been released says so — "Audio
removed on 3 October; the transcript is kept" — instead of silently offering nothing, and a
meeting whose transcript is good offers **Remove the audio** to reclaim the file right away
instead of waiting for the window.

### Recording automatically

Two switches sit in the Meetings header. **Record meetings automatically** is off until you turn it on; with it on, a meeting starts recording itself as it begins — anywhere from two minutes after its start time to a minute before it. **Only with a join link** is on by default and keeps the rule to meetings that have somewhere to join, so a block held in the diary is not recorded.

A meeting whose decision isn't a clear Going — Maybe included, since maybe is recordable by hand but never starts itself, and this reads the same local decision "Deciding whether to go" below describes, not just the calendar's own RSVP — an all-day block, one already recorded, and one marked "Don't record" on its row are left alone, and nothing auto-starts while another recording is running. A recording started this way stops five minutes after the meeting's scheduled end; **Keep recording** on the dock chip cancels that for a meeting that runs over, and **Stop** ends any recording there and then.

### Meetings from a published calendar

The activity helper reads macOS Calendar, so any account added in System Settings › Internet Accounts with Calendars on shows up on its own. Outlook's own cache cannot be read (the new Outlook keeps an encrypted store and its scripting bridge exposes no events), so for an Outlook account not on the Mac, publish the calendar instead: in Outlook on the web, Settings › Calendar › Shared calendars › Publish a calendar, choose "Can view all details", and paste the ICS link into the **Calendar feed** row under Meetings. Saving the link syncs it straight away and the server re-reads it every five minutes, thirty days back and sixty ahead, recurrences expanded and cancellations dropped. The link is a secret: it is stored as a setting and never leaves the machine. Feed events and helper events live side by side, and each source only ever removes its own — so an account that is both on the Mac and published shows each meeting twice; pick one route for it.

### Deciding whether to go

Each meeting also carries your own answer, kept apart from whatever the calendar says: **Going** (the default), **Maybe** (counts as half against the Planner's capacity, recordable by hand from its row but never started automatically), or **Not going** (excluded from capacity, from the day, and from auto-recording). This is a record, not a reply — the app cannot send anything to an organiser, since both EventKit's own RSVP field and a published calendar feed are read-only from here. Choosing anything but Going on a recurring meeting asks whether it's just this one or every time it happens — and going back to Going asks the same question whenever a series currently has a standing decision to actually reverse, so undoing a declined series is one choice, not one click per future occurrence. A meeting marked Not going shows a line and a button to open Calendar so you can tell the organiser yourself, in one click, if that still matters. A declined meeting is kept, not deleted for being declined — the meetings view can show everything, hide them, or show only the ones you turned down — but like everything else here it ages out under the same retention window described under "Activity tracking" above.

A meeting can also be filed to a project or an area, the same containers as everything else. A project or area page lists the meetings filed there alongside its tasks and notes, and the meetings view can be narrowed to one of them. The app will offer a container it recognises from the title or the attendees, but it never files one on its own — a meeting filed to the wrong project is worse than one filed nowhere.

### The audit

`/meetings/audit` groups the last ninety days of meetings (or the retention window, whichever is shorter, so the page never claims to cover data that has already aged out) into recurring series and asks, for each one: how often it runs, how many hours it has taken, how many you didn't decline, whether notes exist and whether a transcript exists, and what work — named apps and sites, not a guess — actually happened while it ran. Rows are ordered by hours taken, because the recurring half hour is worth examining and the rare three-hour workshop is not. One line at the top reads this week's meeting time as a share of the working week the Planner already tracks.

There is no score, no health label, and no colour ranking anywhere on this page. The audit hands you the evidence for how often a series runs, how much time it takes, whether you showed up, whether it produced anything on paper, and what you were actually doing while it ran — and leaves the answer to you, on purpose; that judgement is the point, not something software should make for you. The only control on the page is **Not going**, for the next occurrence or for the whole series, and it writes through the same local decision described above, nothing more.

## Home

`/` is where the day stands, and `/today` lands there too. The band across the top is the Planner's own date and capacity line — how much is planned against the time the calendar leaves free, what is blocked and unplaced, and the chip that sets the working hours — over three figures that read "3 planned", "2 meetings" and "4 in the inbox" and link to the views behind them; a figure of zero says "Nothing planned", "No meetings", "Inbox clear" instead; from Friday, a week with no review yet adds one quiet "Review your week" line beside them, gone the moment one exists. **Now and next** holds whatever is happening: a meeting with its end time, a Join link and a Record button, or a session with the task's own checkbox, and under it the next two timed things today. On a day whose plan has nowhere to go yet it offers **Place in free slots**, the Planner's Fill the day said from here, toast and offer of tomorrow included. Below that is today's plan — the same rows the Planner shows, with their menus and `p`, `n` and `f`, the capacity bar, and the picker that feeds it; the morning ritual and the timeline stay on the Planner, which is one "Open the Planner" link away. The right column carries **Projects in motion**, at most six active projects with something open to do on them or a deadline inside a fortnight, each card naming the open count with a progress figure, the next open task, and the deadline in mono — warned inside a week, red once it is past; **Recent**, the last five things touched with how long ago and a chip on a meeting that has a transcript or a summary; and **Activity today**, the active time so far and the three apps or sites that took most of it, hidden until the helper has reported.

## Planner

`/planner` has three views: **Day**, a timeline of the day's meetings and the plan beside it; **Week**, seven columns of meetings and due tasks, drag a task to another day to change its due date, or pick a day from its "Plan for" menu to add it to that day's plan; and **Meetings**, every meeting in the next 60 days, searchable by title, organizer, or attendee. Plan a task for today from its row menu anywhere in the app; a plan left unfinished offers a one-click carry-over to move it to today.

**Planning the day.** The Day view is the timeline beside the plan. Tasks reach the plan through the field under it: type to search every open task, or type something new and Enter creates it (with `~25m` and due-date words understood, as in the prompt bar) and plans it in one go. Before you type it suggests what is overdue, due today and left from yesterday, and the Due, Inbox, Projects and Areas chips browse one home at a time. Enter plans the highlighted row and keeps the field ready for the next; `⌘Enter` plans and closes; Escape or a click away closes it; `⌘/` puts the keyboard there from anywhere on the page. Estimates come either from the prompt bar, where `~25m` or `~1h30m` on the end of a new task sets one, or from the `est` chip on any task row, which offers a few presets and takes 5 to 480 minutes. A session length can ride along on the same word: `~2h/45m` sets a two-hour estimate split into 45-minute sessions, in both the prompt bar and the plan's own field. On an empty plan for today, a morning ritual walks through carrying over yesterday's unfinished tasks, planning what is overdue or due, and picking something from a project; steps with nothing to offer are left out, so it runs one to three steps long. Each step can be skipped, and once it is walked through it stays away for the rest of the day. Press `p` on any task row to put that task on a plan — today's plan in most of the app, that column's day in the Week view — and press it again on a planned row to take it off. The command palette lists matching open tasks under **Plan** once two characters are typed, and choosing one puts it on today's plan.

**The forecast.** The header's capacity line reads three figures, in order — "3h 40m planned · about 4h 10m at your pace · 2h left today" — and the middle one is the point. It comes from **drift**: the median, not the mean, of actual-over-estimate across this person's last 30 finished tasks — one task that ran six times over says something about that task, not about the next one — floored and capped so a single bad week can't send it to zero or to infinity. This is the outside view: not how long the task looks like it will take, which people guess at wrong in the same direction every time, but how long work like it has actually taken this person, which needs real history behind it rather than a plausible-sounding number. Below 8 finished pairs the middle figure is dropped rather than built from too little to mean anything, and a line beside the other two says so plainly: "Not enough finished work yet to know how your estimates run." Overcommitment still shows without one, though: when the plan itself outruns what the day has left, the line adds a sentence rather than a colour — "About 2h more than today holds" — arithmetic on two numbers already in hand, since a plan can be too big for a day before there is any pace to measure it against. The same drift reads into the Week view too, once for the whole week rather than once per day: a column's colour judges that day by the same forecast the header's own line and meter would, not by the bare plan, so a day that reads calm here never reads overrun on its own Day view — the week draws no forecast figure of its own, only the tone. A day outside the saved working days — Monday through Friday until changed, and changeable from the same chip the working hours are — reports zero capacity across the board rather than the working hours it would otherwise claim, and the plan behind it is never even read.

Once a project or area has enough finished work of its own, the same idea reaches a single task: an estimate chip with nothing in it yet offers "Tasks like this have taken about 50m," and a button that sets it. The match is deliberately dull — the same container, a title word of four letters or more shared with this one after lowercasing, the other task done with minutes actually booked against it — and stays quiet below three such tasks. A hint built from one coincidence is a guess dressed up as an insight, and a wrong number offered with a straight face is worse than none, so both this and the capacity line above would rather say nothing than invent a multiplier.

**Time-blocking.** A task holds any number of **sessions** on the timeline. Drag a plan row onto the column to place one where it lands: it is as long as the task's session length, which is the whole estimate up to an hour and 45 minutes beyond that, and never shorter than 15 minutes, and **Split into** on the row menu sets it to 25, 45, 60 or 90 minutes, or back to **One session**. A task dropped with no estimate is asked how long the session is, and the answer becomes both. Drag a session to move it, drag its bottom edge to resize it, or take the keyboard to it — the arrows move it by 15 minutes, Shift and the arrows by 5, Alt and the arrows resize it, and Backspace takes it off the timeline without taking the task off the plan. A task with more than one session on the day marks each one · 2 of 3.

**Place in free slots** on a row menu, or `f` on the focused row, clears the task's sessions on the day and lays fresh ones into the gaps the calendar leaves, earliest first and never straddling a meeting or another session. On today it starts no earlier than now; on any other day it starts at the top of the working hours. Two sessions of the same task laid in one gap keep ten minutes apart — the break is not held for the task, so anything else placed after it may take that time. **Fill the day** in the plan's own menu does the same for every plan task that has no session yet, in plan order. What the day had no room for is **unplaced**: the toast after a place says "Placed 3 sessions, 1h 20m unplaced" and offers **Place tomorrow** (named for the day itself, **Place on Fri 25**, when the day on screen is not today), which from a single row plans the task for the next day and places it there; after **Fill the day** it plans nothing new — it places what the next day already carries. A toast with an offer stays for twenty seconds, `⌘.` takes it from anywhere, and Escape puts it away; the header's capacity line carries the unplaced figure after the blocked one.

**Block now** on a plan row menu, or `n` on the focused row, starts one session at the next five minutes, and **Take off the timeline** clears the day's sessions. A row with a session shows when the first one starts, with a "+2" counting the others the day holds, and pressing it scrolls the timeline to that session and hands it the keyboard. The plan's menu sorts the day's rows by their first session with **Sort by time**, and rows with no session keep their order at the end. The header's capacity line says how much of the plan is blocked, the bar under the plan shows it as a brighter segment, and a day with blocked time carries a violet dot in the Week view.

## Focus

A **run** is a plain countdown against one task, started from the Focus button on any task row, from a session on the timeline, or with `⌘⇧F` on whatever task the keyboard sits on — which also switches a live run to a different task, or stops the one already going, since only one run is ever live at a time. Its length comes from an explicit choice, else the session it was started from, else the saved default (25 minutes, alongside a short and a long break length). While it runs, the dock carries a chip with the task's name and a countdown; `⌘⇧F` or the chip's Stop ends it early with the minutes it actually ran kept, and letting the clock reach zero books exactly the length it was set for.

A run's minutes **book against the task** the moment it ends, successfully or not: they show on the task's own row as what it actually cost, next to what it was guessed at — "Estimated 45m, spent 1h 20m" — and where the two disagree by more than a few minutes, or there was no guess at all, a button offers to make the real figure the estimate, so the next task of the same shape is guessed better. A run ended inside its first two minutes is a mis-click, not work, and books nothing. Home's top band adds the day's booked minutes beside its other counts, and a run still going takes the **Now** slot over a session in progress — the person is demonstrably working on that one — though never over a meeting, which is where they have to be regardless.

What **stalls gets reconciled**: a run left open past its planned end by more than half an hour is treated as a browser closed mid-run rather than work still going, and is closed out at the end it was meant to have, booking exactly its planned length. **Breaks are offered, never recorded** — finishing a run on its own clock offers a short or long break (long every fourth completion of the day) as one line, never a modal; taking it starts a plain countdown on the page, and leaving or dismissing it loses nothing, because nothing about a break is ever saved.

## Goals

`/goals` holds the outcomes above your projects: a quarter or a year, a target date, and any number of projects or areas linked to it. A goal has no tasks of its own — its progress is the open and done count of whatever it is linked to, summed and read as one percent, so a goal and the projects under it can never disagree on where the work stands. **Stalled** means nothing has closed against a goal in 14 days, or it has nothing linked to close at all; the row says so in words, without alarm, rather than turning red. Closing a goal asks whether it was hit, missed, or dropped, and a closed goal drops off every task row and container page it used to badge — only an active goal's name follows its work around the app. `g g` opens Goals from anywhere.

## Weekly review

`/review` walks one week at a time through four steps — **Clear the decks**, the inbox count and whatever is still left open from the week, with a carry-to-next-week or a drop on each; **Look back**, what closed, what dropped, what slipped, the time spent focused, the meetings sat through, and the projects that moved; **Goals**, a note against each active goal as of the week; and **Look ahead**, next week's due tasks, deadlines, and meetings, with a one-click plan for whatever is worth carrying in. Nothing saves on a keystroke — only on leaving a step, leaving the page, or closing the tab — so a review can be started, abandoned mid-sentence, and picked back up exactly where it stopped, on this device or any other. The first answer saved writes the item, and every later one rewrites it — readable in the Library like any note and found by the same search, under a title that names its week; opening the same week again never makes a second one. `g w` opens it from anywhere, and from Friday morning Home carries one quiet line to it — "Review your week" — for as long as the current week has none; the line asks once and does not return once a review exists, or grow more insistent as Sunday runs out.

Goals set the direction, Focus and the Planner are where the week's hours actually go, and the weekly review is where the two are read back against each other — what moved, what didn't, and what next week should carry. Direction, execution, reflection: three slices, one loop, each closing into the next.

## Data safety

The database backs itself up every night, verified before it is trusted and kept for six months;
a migration takes its own snapshot first; and one command puts any of them back without deleting
what it replaces. Meeting audio is not part of that backup — see "Meetings and recording" above
for its own retention, which the same nightly job runs. See `docs/superpowers/runbook.md` for
what to run when something looks wrong — it names the one thing this does not cover: everything
above lives on this one machine.

## Design docs

- Spec: `docs/superpowers/specs/2026-09-12-second-brain-design.md`
- Plans: `docs/superpowers/plans/`
