# The desk: decisions, not rows — design

Date: 2026-11-15. The desk works exactly as [its design](2026-11-08-desk-design.md) specified and
has never once been used. This revises the unit it deals in, not its philosophy.

## 1. What the evidence says

Measured against the running app, 2026-11-15:

```
shown on the desk : {task_overdue: 7}
open in total     : 10
decided today     : 0
ever decided      : 0 accepted, 0 dismissed, 1 auto-expired
sweeps run        : 810
```

Nothing has ever been accepted or dismissed. The one non-open row expired on its own.

The original design set its own test and was explicit about the stakes: *"if the desk is not
something you clear each morning, adding intake only makes a louder firehose, and that is worth
finding out before the app holds anything sensitive."* Slack intake landed earlier today. The test
was never run, so run it now.

Two things are wrong, and neither is the philosophy.

**A card is a row, when it should be a decision.** Generators emit one draft per database row. A
single programme import therefore produced seven near-identical cards — same kind, same cause, same
due date, same sentence. Answering that seven times is not seven decisions. The real decision is
"am I still doing this programme?", and the desk cannot ask it because no generator can see more
than one row at a time.

**The cap assumed variety.** Seven open was meant to make clearing feel finite. Instead one noisy
kind occupies every slot: `task_stalled` (rank 0.18) and `commitment_unbooked` (0.135) are open
right now and *invisible*, and will stay invisible until all eight overdue cards are answered one
by one. The failure the cap was designed against was a panel that grows. The failure that actually
happened is a panel that gets monopolised, which looks identical from the outside — you stop
seeing it either way.

The layout makes both worse but causes neither: the card is a strip in the top-left of an empty
column, and the keyboard hints read `⏎ · . · n`, in which the snooze key *is* a period and the
separators are middle dots, at 11px in the faintest grey.

## 2. Out of scope

Grouping for every generator. Per-kind caps stop one source burying the others, which is the part
that matters; `task_overdue` is grouped because it is the one with a real cluster in front of it
today. `ask_unanswered` and `commitment_owed` can cluster the same way later, and the mechanism
here is deliberately one a second generator can copy rather than a framework none of them asked
for.

Folding the desk into Today. Worth considering if grouping does not change the clear rate, but it
is a rebuild and this is a day's work; find out cheaply first.

No schema change. `count` rides in the existing `payload` column.

## 3. Per-kind cap

`openProposals` applies the cap in SQL today. It gains a second, per-kind limit:

```ts
export const OPEN_CAP = 7;
/** At most this many of any one kind among the open seven. Two, so a kind with a genuine cluster
 *  still gets a voice and a second opinion, and five slots stay for everything else. */
export const PER_KIND_CAP = 2;
```

Applied after ordering by rank and before the overall cap, so the best two of a kind survive and
the rest wait. This is what guarantees the cap's original promise: clearing the desk is possible
*and* what is on it is representative.

A kind's hidden rows are not dropped — they stay `open` and surface as earlier ones are answered.
`deskPayload.open` continues to report the true total, so the page keeps admitting its arithmetic.

## 4. `task_overdue` groups by container

A container is the honest cause: these tasks are late because the thing they belong to has
stalled, not because each of them individually slipped.

- Overdue tasks sharing a `containerId` group into one draft when there are **two or more**.
- Tasks with no container never group — there is no cause to name.
- `sourceRef` becomes `container:<id>:overdue`, stable across sweeps so a dismissal sticks.
- Title: `7 tasks in Staff Engineer 52 weeks are overdue`.
- Detail: `Oldest due 2026-11-01, 14 days ago. Nothing set aside for any of them today.`
- Urgency: the oldest member's, unchanged in shape — the group is as urgent as its worst task.
- Payload: `{ taskIds: number[], containerId, count, days, dueDate }`.

### What accepting commits

Plans every member for today, and undo removes every one it added. The same `planForToday` helper
the single-task arm uses, over a list.

Planning seven things for one day is a lot, and that is the point: the card's job is to make the
state visible and put the work where it will be triaged, not to pretend seven overdue tasks are
fine. The alternative — navigating to the project and committing nothing, as `prediction_due` does
— was considered and rejected: it makes the card impossible to clear, and a card that cannot be
cleared is the failure this whole revision is about.

### Saying what accept will do

The original design is firm that *"a generator that cannot say exactly what accept will do has no
business filing a proposal"*, and `PRIMARY_LABELS` is keyed by kind alone, so a grouped card would
be labelled "Plan it for today" while planning seven things.

`ProposalDraft` gains an optional `count` (default 1), stored inside `payload` and surfaced on
`ProposalDTO`. `PRIMARY_LABELS` becomes a function of kind and count:

```ts
task_overdue: (n) => (n === 1 ? "Plan it for today" : `Plan all ${n} for today`)
```

No migration: `count` rides in `payload`, which is already JSON and already read when accepting.

## 5. The layout

Three defects, all in `desk-page.tsx`:

- The card is pinned top-left in a tall empty column. It gets centred horizontally and placed in
  the upper third rather than flush against the header, so the one decision on screen reads as the
  point of the page. The same top-alignment affects every page in the app; only the desk is fixed
  here, because only the desk has a single small element in all that space.
- `⏎ · . · n` becomes `Enter · . · N` with the separator visibly distinct from the keys, at a size
  that can be read.
- The rail gains the padding the header never had.

## 6. Tests

- Per-kind cap: two of a flooding kind survive, the rest wait, other kinds stay visible, and
  `open` still reports the true total.
- Grouping: two or more in a container make one card; one alone stays a single card; tasks with no
  container never group; the group's urgency is the oldest member's.
- Accept: plans every member, undo removes every one, and a member already planned is not
  double-added nor removed by the undo.
- Label: singular and plural read correctly.
- The existing single-task behaviour keeps its tests unchanged.

---

## Revision, same day: the queue becomes a board

§3 capped a kind to two of seven and §5 kept one card on screen. Both are withdrawn. Shown the
grouped version, the reaction was immediate and correct: *"it only shows one at a time. why not all
in some categorisation... give you a whole picture and source."*

The original argument was that "a queue you can scan is a queue you can defer". It is a real risk
and it lost to a larger one: a page that hides nine of ten things gives you no reason to open it,
and a page you do not open cannot be answered. Zero decisions in 810 sweeps is that argument
settled by measurement rather than taste.

- **Everything open is on the page.** `BOARD_CEILING` (50) replaces `OPEN_CAP` and `PER_KIND_CAP`;
  it is a backstop against a runaway generator, not a feature. The real limits stay upstream where
  they belong — `ASK_CAP` holds a Slack backfill to twenty, and grouping collapses a container's
  worth of overdue tasks into one row.
- **Grouped by the attention a thing needs**, not by generator: *Someone is waiting on you*,
  *Happening soon*, *Past its date*, *The plan disagrees with reality*, *Loose ends*. Empty
  headings are not drawn. A test asserts every `ProposalKind` has exactly one home, so a new
  generator cannot file proposals that render nowhere.
- **Tabs were considered and rejected.** A tab is a thing you do not look at, which is the failure
  being fixed.
- **Every row names what it is about and links to it** (`origin`, resolved server-side from the
  payload). A sentence you cannot check is one you either take on trust or ignore, and ignoring is
  cheaper. This is the part the single card never had.
- **The fast path survives**: `j`/`k` move, `Enter`/`.`/`N` answer the focused row. That is what
  one-at-a-time was really protecting, and it never needed the hiding to work.

What carries over unchanged: grouping `task_overdue` by container, `count` and the labels that name
it, the ranker, and the dismissal learning.
