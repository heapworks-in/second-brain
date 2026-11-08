# The desk — design

Date: 2026-11-08. One ranked queue of things that want a decision from you, filled by a sweep over data the app already holds, and the only surface the app is allowed to propose from. First slice of the assistant direction; later slices add sources, not surfaces.

## 1. Purpose

The app already knows a great deal that it never asks you about. A decision recorded in a meeting series seven months ago is still presented as current. A task you have planned four days running with no focus minutes on it sits in the plan looking the same as one you worked. A prediction is past its resolve-by date. An inbox capture from last week has no home. Home, the Planner, Review and the project pulse all *show* this; none of them asks you to do anything about it, and so nothing happens.

The desk is that ask. At most seven open at a time, one on screen at a time, each a single decision with the evidence under it and two or three ways to answer. It reads from the same tables everything else reads; what is new is that answering commits, and that dismissing teaches.

Two things make it a desk rather than another dashboard panel. **The cap**: seven open proposals, so clearing it is possible and therefore habitual — a panel of warnings that grows is a panel you stop seeing within a week. **The dismissal**: "Never" downweights its whole kind, so the queue gets quieter in the shape of your actual judgement rather than staying loud and being ignored.

It is also the seam for everything after this slice. Notifications, window text, Slack and drafted replies all write `proposals` rows; none of them needs a surface of its own.

## 2. Out of scope for this slice

No screen reading, no Notification Center, no Slack, no mail, no drafting, no new TCC permission, no new process. Every generator below reads tables that exist today. This is deliberate: if the desk is not something you clear each morning, adding intake only makes a louder firehose, and that is worth finding out before the app holds anything sensitive.

## 3. The proposal

New table `proposals`:

```
id            integer pk
kind          text not null      -- decides what accept commits; see §4
source        text not null      -- "meeting" | "decision" | "task" | "prediction" | "item"
sourceRef     text not null      -- "decision:4"; identity for upsert, not a foreign key
title         text not null      -- the one line you read
detail        text not null      -- the evidence, one or two lines, no advice
payload       text not null      -- JSON; what accept commits
rank          real not null      -- stored so the order is stable while you work the list
state         text not null      -- "open" | "accepted" | "dismissed" | "snoozed" | "expired"
snoozedUntil  text               -- set by "Not now"
createdAt     text not null
decidedAt     text
unique(kind, sourceRef)
```

`sourceRef` is a string rather than a relation because a proposal outlives the row that caused it — a dismissed `decision_stale` must stay dismissed after the decision is edited, and a deleted task must not cascade away the record that you were asked about it.

`payload` carries the commit, so accepting never re-derives anything. A generator that cannot say exactly what accept will do has no business filing a proposal.

## 4. The generators

Each is a pure, synchronous function `(db, now) => ProposalDraft[]` in `src/domain/desk/generators/`, exported through one array so adding a source is adding a file. Synchronous and provider-free on purpose: the embedding provider can be switched off (`SB_EMBED=off`), and a queue that empties when a model is missing would be worse than no queue. Seven in this slice:

| kind | fires when | accept commits |
|---|---|---|
| `meeting_unprepared` | a meeting starts within 4 h, has other attendees, and its series has no agenda note or carries open decisions from the last instance | opens the prep note, pre-filled with those open decisions |
| `decision_stale` | a `meeting_series_decisions` row is older than 90 days and has never been reaffirmed | stamps it reaffirmed (`lastVerified`, `confidence`) |
| `task_overrun` | an open task's focus minutes exceed its estimate by more than half | re-estimates to the minutes actually spent, rounded to the nearest quarter hour |
| `task_stalled` | a task has been planned on 3+ distinct days with zero focus minutes | unplans it |
| `prediction_due` | a prediction is past its resolve-by date | opens the resolve step |
| `capture_unfiled` | an inbox item is older than 7 days with no container | files it into the container of the closest existing item by FTS, named in the card |
| `commitment_unbooked` | a meeting action item has no task | creates the task, linked to the meeting |

`decision_stale` needs two new columns on `meeting_series_decisions` (`lastVerified`, `confidence`) — the one schema change outside `proposals`. The pattern is lifted from COG-second-brain's `memory-hygiene`: trust is a property of the last check, not of the record, and nothing is ever deleted on the app's own initiative. Fully obsolete entries are proposed for archive, which here means a dismissed proposal and a note, never a `DELETE`.

## 5. The sweep

A `desk` job handler in `src/jobs/handlers/`, queued by an interval in `boot.ts` every 15 minutes, following `distillSweepTick` exactly: wrapped so a thrown generator never kills the timer, and cheap enough to just poll. `POST /api/desk/refresh` queues the same job for the "Refresh" affordance.

`reconcileProposals(db, drafts, now)`:

- upsert each draft by `(kind, sourceRef)` — a re-run never duplicates, and re-running after you have decided never resurrects
- any `open` proposal whose generator no longer emits it becomes `expired` — the meeting happened, the task got worked, you filed the capture elsewhere. Conditions that resolve themselves must leave on their own, or the cap fills with stale cards
- `snoozed` rows past `snoozedUntil` return to `open`

One transaction, one pass. No generator writes directly.

## 6. Rank

Deliberately arithmetic, not a model:

```
rank = urgency * weight(kind) * (1 - 0.9 * dismissRate(kind))
```

- `urgency` — time pressure normalised to 0..1: hours until the meeting, days past the resolve-by date, days since the capture landed. Each generator supplies its own.
- `weight(kind)` — a constant per kind in `settings`, so you can mute a whole class without code. The generators' own thresholds (90 days for a stale decision, 7 for an unfiled capture, 3 planned days for a stalled task) live beside it for the same reason.
- `dismissRate(kind)` — dismissed over decided across the last 30 proposals of that kind; expiry is not a decision and is not counted. A kind you have refused nine times in a row sinks; one you always accept rises. The `0.9` is a floor: at a rate of 1 a bare `(1 - rate)` reaches zero and takes urgency with it, so two refused kinds tie at nothing and the only route back up is a decision the desk would never again offer. A tenth of the weight keeps a refused kind sorted by its own urgency at the bottom, and lets one acceptance lift it straight out. Muting a kind outright stays a deliberate setting, not something nine impatient dismissals do by accident.

Top seven by rank are `open` and shown; the rest wait. The list does not re-sort while you work it — `rank` is stored, and a re-rank happens on sweep.

This is the whole learning loop, and it is three integers. A ranker you cannot explain to yourself is one you will not trust enough to act on.

## 7. The surface

`/desk`, a dedicated page. Home stays the quick view of everything at once; the desk is where things get decided, and those are not the same job — a deciding surface folded into a scanning surface becomes a scanning surface.

**One card at a time.** Not a list of seven. A list lets you take the three easy ones and leave the one that mattered, and a queue you can scan is a queue you can defer — the cap argument in §1 fails if the page invites browsing. The desk shows the top-ranked proposal alone, at the width of the content column, evidence under the title, answers under that. Answering replaces it with the next. Behind it a thin rail — "2 of 6", with the kinds still waiting as dots — so the shape of the morning is visible without being workable.

**The evidence is on the card.** A page you must leave in order to decide is a dashboard with buttons on it. Each card carries what its generator already read: the meeting's open decisions, the task's estimate against its actual focus minutes, the capture's own text and the container it would land in. `detail` stays plain text in this slice — all seven kinds fit in two lines — and a per-kind renderer waits until one of them measurably does not.

**Answers are numbered and named for their consequence.** `1`/`2`/`3`, because they differ per card and `Enter` cannot mean three things; `Enter` takes the primary. "Reaffirm", "Re-estimate to 3h", "File in Migrations" — never a generic "Accept". Then `.` for "Not now" (snooze 7 days) and `n` for "Never" (dismiss, downweight the kind). The mouse works throughout; the keyboard is what makes it quick.

**Undo, not confirm.** Every answer commits at once and leaves one line for eight seconds: "Re-estimated to 3h. Undo." A confirm step on a queue of seven costs fourteen decisions instead of seven. Undo is also the honest affordance — the commit has happened; the only question left is whether you keep it.

**A finish line.** Clearing the last card says what the pass was worth: "Desk clear — 6 decided, 2 reaffirmed, 1 never." That count is the reason to come back tomorrow. Arriving at an already-clear desk is still one line: "Desk clear."

`/desk?p=<id>` opens on one named proposal, so a link from Home — or, later, a notification — can hand over a single decision without the queue.

Home carries one line: "3 on the desk", linking here. Not the cards; the point of a dedicated page is that the decisions live in one place.

Dock: a count badge, hidden at zero, on the inbox badge's existing poll.

A `sb:desk-changed` event, debounced like `sb:plan-changed`, keeps the badge, Home's line and the page honest across surfaces.

## 8. Testing

Each generator gets a table-driven test with a fixed `now`: fires, does not fire, and does not fire twice. `reconcileProposals` gets the four transitions (new, unchanged, expired, snooze-return) and the upsert-after-dismissal case, which is the one that matters — a dismissed proposal that comes back is the bug that makes the whole surface untrustworthy. The rank function is pure and gets its own test, including the all-dismissed kind sinking below a never-dismissed one. The page gets the number keys, the undo (a commit followed by an undo leaves the proposal open and the side effect reversed), the one-card-at-a-time advance, and both empty states — cleared-just-now with its counts, and arrived-clear.

No fixed-date tests: `now` is injected everywhere, the way `detectIntent` already takes it.

## 9. What comes next, and why this order

1. **This slice** — the queue, the sweep, the surface, seven generators, no new permissions.
2. **Notification Center** — a reader behind the Full Disk Access grant, writing `proposals` with `source: "notification"`. The only intake that sees what you never looked at.
3. **Window text** — `sb-activity` already holds Accessibility and already walks one level of the AX tree; reading the focused window's text is the same API deeper. Per-app allowlist, off by default, raw text on a 14-day TTL.
4. **Slack desktop** — native AX tree, once installed.
5. **Drafting** — behind the `src/providers/chat` interface, so local-only and API-backed are a setting rather than a rewrite.

Outlook's local store was investigated and rejected: `Outlook.sqlite` still has `Mail` and `CalendarEvents` tables but they are empty, because new Outlook for Mac keeps everything in `HxStore.hxd` and `hxcore.hfl` — 62 MB of undocumented binary. Mail is reachable only through the screen or its notifications. The calendar is the exception and already works, through `syncOutlookWidget`.
