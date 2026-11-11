# People who depend on me, and the sheets they live in

## 1. The problem

Some of the work here is not mine. I manage projects where other people are
blocked until I do a small thing, and those things arrive the way favours
arrive: said out loud in a meeting, asked in a corridor, or written into a
row of a shared spreadsheet that somebody else will read on Monday.

Today the app cannot represent any of it. A task has a container, a due date
and a priority — all three are facts about *my* schedule. None of them says
"Priya cannot start until this is done", which is the only fact that matters
about a task somebody is waiting on. The result is that these tasks lose
every ranking contest against work with a real deadline, and the cost of
losing lands on someone else's week rather than mine.

The second half is the format. These projects live in spreadsheets with
roughly these columns — theme, task, sub task, owner, eta, team, comments,
status — and the sheet is how the team reads the project. Anything the app
knows has to be able to come from one of those files and go back out to one.

## 2. The model

Two nullable person columns on `tasks`, and the direction is derived:

| owner | requester | reads as |
| --- | --- | --- |
| null (me) | null | ordinary task of mine |
| null (me) | Priya | **Priya is waiting on me** |
| Priya | null | Priya's row in a project I run |
| Priya | me (null-owner's inverse) | **I am waiting on Priya** |

```
tasks.ownerPersonId      -> people.id   (null means me)
tasks.requesterPersonId  -> people.id   (who asked)
tasks.askedOn            -> YYYY-MM-DD  (the day they asked, not the day I captured it)
```

`askedOn` is its own column rather than `createdAt` for the reason `droppedAt`
is: they asked on Tuesday and I wrote it down on Friday, and the wait is
measured from the ask. It is also the only clock these tasks have — most will
never get a due date, because nobody sets one when they ask you for a favour.

Who is waiting is never stored. It is whoever is not the owner, which means
the two directions can never contradict each other and no migration is needed
when one becomes the other.

`parentTaskId` (one level deep) and `theme` (text) land with the importer in
slice 2, which is the first thing that can produce either. Until then they
would be columns with no writer.

## 3. Capture

An `@handle` anywhere in the add-task box names the requester, resolved
against `people.slug`. The handle stays in the title, exactly as
`autoLinkMentions` leaves it in an item's body: a handle that matches nobody
is then still readable text rather than something silently eaten, and nobody
gets created by a typo. Setting the requester also sets `askedOn` to today
unless the caller gives a date.

The task row grows a chip — `Priya · 3d` — beside the due chip, and the row
menu grows "Waiting for…", which opens the existing `PeoplePicker` in a
single-select mode. Nothing here is reachable only through the `@` syntax.

## 4. The desk asks about it

A new kind, `commitment_owed`: a task I own, that somebody asked for, that has
been waiting at least `desk.owedWaitDays` (2), and that holds no session on
the timeline. Accepting puts it on today's plan; the undo takes it off again.

Its urgency **grows** with the wait, which is the opposite of
`commitment_unbooked` and deliberate: a commitment you dropped goes stale and
stops mattering, but a person waiting on you gets angrier. Weight 0.85, above
everything except a meeting about to start and an unbooked commitment, because
it is the only kind of debt here that compounds in somebody else's calendar.

No session on the timeline is the condition, not "not done": a task I have
already given time to is in progress, and the desk has nothing useful to add.

## 5. Where else it shows

- **Planner.** A new `sources.owed` — unplanned tasks with a requester, longest
  wait first — as its own picker filter and at the head of the default
  suggestions. For these the wait is the deadline, so they sort above undated
  work.
- **Person page.** "Waiting on you", above the timeline. Opening a person is
  the other way people ask this question ("what do I owe Priya?").

## 6. The flooding hazard, and the predicate that answers it

16 queries across 9 files read `tasks` today: the planner, Home's counts,
container progress, the weekly review, three desk generators, focus. Import
200 rows of a team tracker of which 6 are mine and every one of those surfaces
fills with other people's work — my capacity line, my review, my desk.

So `mine` is a single predicate, `isNull(tasks.ownerPersonId)`, defined once in
`src/domain/tasks` and applied to all 16, with a test per surface asserting a
teammate's row never appears in it. That work belongs at the **start of slice
2**, before the importer can write a single foreign row — ahead of it, the
predicate would be dead code; behind it, the first import is the bug report.

## 7. The sheet

A `trackers` row per imported file holds what the app must remember to give
the file back: name, container, the header mapping, the status mapping, and
where it came from. `tasks.trackerId` points at it.

- **Unmapped columns** — the "etc." — are kept verbatim per row in a JSON
  column, so an export rebuilds the file whole rather than the four columns we
  understood.
- **Status needs two fields.** `status` (`open|done|dropped`) stays the
  lifecycle the app reasons with; `statusLabel` holds the word humans read —
  "In Progress", "Blocked", "On Hold" — written together with `status` on every
  change so the two cannot drift. Import keeps the original word; nothing is
  silently flattened into "open".
- **ETA** maps to `dueDate` when it parses (ISO, Excel serial, d/m/y). What
  does not parse is reported row by row in the import summary, never guessed.
- **Owner** matches a person by name, offering to create the ones that are new,
  with `team` filled from the sheet's team column.
- **Export writes an `SB ID` column.** The loop that will actually be run is
  export → teammates edit → import back, and that column turns a fuzzy merge
  into an exact one. A foreign sheet with no `SB ID` matches on theme + task +
  sub task and lists everything it could not place.
- **Theme** is a text column, grouped by exact string, because that is what the
  sheet means. The import preview offers the other reading — "treat Theme as
  the project each row belongs to" — as a choice, rather than guessing which
  way these sheets work.
- **Identity.** The app has no notion of who I am, so the importer cannot tell
  my rows from anyone else's. Import asks once, stored as `identity.names`
  (several: "Avinash", "Avinash V", initials). The same setting gives meaning
  to the `owner` field the meeting summariser has been writing all along.
- **`exceljs`**, one new dependency. Hand-rolling xlsx is a zip container, XML,
  date serials, inline strings and cached formulas — every one of which a
  colleague's real file will contain.

Nothing is imported without a preview: the header mapping, the status mapping,
which names are me, and a count of what will be created, updated and skipped.

## 8. Out of scope, with reasons

- **`handoff_overdue`** ("Priya's row is 5 days past ETA"). The right action for
  it is a nudge, and there is no channel to nudge through, so the card would
  have nowhere to land. It arrives when there is one.
- **Any messaging.** No Slack, no email, no "tell Priya it's done".
- **Inferring the requester** from a meeting's attendee list when a
  `commitment_unbooked` card is accepted. Plausible, wrong often enough to
  annoy, and one press on the chip does it honestly.
- **Container-level rollups** ("3 people waiting on this project") wait for
  `ownerPersonId` to have a writer, in slice 2.

## 9. What was built, and where it differs

Both slices shipped. Three things turned out differently once the code met a
real file, and the spec says so rather than reading as though it predicted
them:

- **`parentLabel`, not `parentTaskId`.** In a real tracker the "Task" cell is
  repeated (or merged) down the rows and has no row of its own, so a parent id
  would have meant synthesising a task that belongs to nobody and still lands
  in my lists. A label also round-trips to the file; an id cannot.
- **Two cells needed somewhere to live.** An ETA that was never a date, and
  the Team cell on a row of my own — which has no person behind it to read a
  team off. Both ride in the row's stash of untouched columns, so an export is
  not poorer than the file that made it.
- **A handle resolves by unique prefix** after an exact slug match. Nobody
  types `@priya-raman`; two Priyas resolve to nobody rather than to a coin
  toss.

## 10. Slices

1. The two columns, `@handle` capture, the chip and picker, the
   `commitment_owed` card, `sources.owed`, the person page section.
2. The `mine` predicate and its tests, then `trackers`, xlsx import with
   preview, the tracker page, xlsx export. One slice, because half a loop is
   useless.

Fixtures and tests use invented names and invented sheets. The real trackers
name colleagues and client work, this repo is public, and its releases ship the
whole payload in a dmg.
