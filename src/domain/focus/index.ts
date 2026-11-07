import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { focusRuns, tasks, type FocusRun, type TaskBlock } from "@/db/schema";
import { FOCUS_MODES, type FocusMode, type FocusOutcome } from "@/db/enums";
import { getTask } from "@/domain/tasks";
import { getBlock } from "@/domain/blocks";
import { getSetting, setSetting } from "@/domain/settings";
import { addDays, dayBounds, localDay } from "@/domain/activity";
import { getDay, topApps } from "@/domain/activity/report";
import { DRIFT_WINDOW, type Pair } from "@/lib/drift";
import { shareWord, significantWords } from "@/lib/significant-words";

export class FocusError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "FocusError";
  }
}

/** A run ended inside this many minutes of its start is a mis-click, not work: it is abandoned
 * whatever it was called, and books nothing. */
export const ABANDON_UNDER = 2;
/** A live run left open past its planned end by more than this many minutes is a browser closed
 * mid-run, not work still going; it is reconciled closed at the end it was meant to have. */
export const STALE_AFTER = 30;
/** How many apps or sites `focusWhere` names. */
const FOCUS_WHERE_LIMIT = 3;

/** The length a single run — or a saved default length — may take. The one place this range is
 * written; `src/lib/validation.ts` imports it rather than repeating the numbers. (Not merged with
 * `src/domain/blocks/index.ts`'s `MAX_ESTIMATE`: that is a task's total *estimate* ceiling, a
 * different quantity that only happens to share this number today — importing across those two
 * domains to save one constant would be the wrong coupling if either ceiling ever moved.) */
export const MIN_FOCUS_MINUTES = 5;
export const MAX_FOCUS_MINUTES = 480;

export interface FocusSettings {
  defaultMinutes: number;
  shortBreak: number;
  longBreak: number;
  longBreakEvery: number;
  /** Which rhythm the focus pane offers, and so whether a finished run ends in a break or in a
   * decision. Saved rather than held in a component: it is a way of working, not a tab. */
  mode: FocusMode;
}

const DEFAULT_MINUTES_KEY = "focus.defaultMinutes";
const SHORT_BREAK_KEY = "focus.shortBreak";
const LONG_BREAK_KEY = "focus.longBreak";
const LONG_BREAK_EVERY_KEY = "focus.longBreakEvery";
const MODE_KEY = "focus.mode";

const FOCUS_SETTINGS_DEFAULTS: FocusSettings = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" };

const MIN_BREAK_MINUTES = 1;
const MAX_BREAK_MINUTES = 60;
const MIN_LONG_BREAK_EVERY = 2;
const MAX_LONG_BREAK_EVERY = 12;

/** A stored value that is not one of the two modes reads as the default rather than taking down
 * every surface that switches on it: the pane renders before anything validates what it read. */
function readMode(db: DB): FocusMode {
  const raw = getSetting(db, MODE_KEY, FOCUS_SETTINGS_DEFAULTS.mode);
  return (FOCUS_MODES as readonly string[]).includes(raw) ? (raw as FocusMode) : FOCUS_SETTINGS_DEFAULTS.mode;
}

export function getFocusSettings(db: DB): FocusSettings {
  return {
    defaultMinutes: Number(getSetting(db, DEFAULT_MINUTES_KEY, String(FOCUS_SETTINGS_DEFAULTS.defaultMinutes))),
    shortBreak: Number(getSetting(db, SHORT_BREAK_KEY, String(FOCUS_SETTINGS_DEFAULTS.shortBreak))),
    longBreak: Number(getSetting(db, LONG_BREAK_KEY, String(FOCUS_SETTINGS_DEFAULTS.longBreak))),
    longBreakEvery: Number(getSetting(db, LONG_BREAK_EVERY_KEY, String(FOCUS_SETTINGS_DEFAULTS.longBreakEvery))),
    mode: readMode(db),
  };
}

/** Writes the keys the patch carries and returns all four, which is what the route answers with.
 * Validates its own patch rather than trusting the route: a value written out of range here would
 * make `getFocusSettings` hand back something `startFocus`'s own check then permanently refuses,
 * for every future caller of no-minutes-given, not just whichever route call did it. */
export function setFocusSettings(db: DB, patch: Partial<FocusSettings>): FocusSettings {
  if (patch.defaultMinutes !== undefined) {
    if (!Number.isInteger(patch.defaultMinutes) || patch.defaultMinutes < MIN_FOCUS_MINUTES || patch.defaultMinutes > MAX_FOCUS_MINUTES) {
      throw new FocusError(`A default length is ${MIN_FOCUS_MINUTES} to ${MAX_FOCUS_MINUTES} minutes`);
    }
    setSetting(db, DEFAULT_MINUTES_KEY, String(patch.defaultMinutes));
  }
  if (patch.shortBreak !== undefined) {
    if (!Number.isInteger(patch.shortBreak) || patch.shortBreak < MIN_BREAK_MINUTES || patch.shortBreak > MAX_BREAK_MINUTES) {
      throw new FocusError(`A short break is ${MIN_BREAK_MINUTES} to ${MAX_BREAK_MINUTES} minutes`);
    }
    setSetting(db, SHORT_BREAK_KEY, String(patch.shortBreak));
  }
  if (patch.longBreak !== undefined) {
    if (!Number.isInteger(patch.longBreak) || patch.longBreak < MIN_BREAK_MINUTES || patch.longBreak > MAX_BREAK_MINUTES) {
      throw new FocusError(`A long break is ${MIN_BREAK_MINUTES} to ${MAX_BREAK_MINUTES} minutes`);
    }
    setSetting(db, LONG_BREAK_KEY, String(patch.longBreak));
  }
  if (patch.longBreakEvery !== undefined) {
    if (!Number.isInteger(patch.longBreakEvery) || patch.longBreakEvery < MIN_LONG_BREAK_EVERY || patch.longBreakEvery > MAX_LONG_BREAK_EVERY) {
      throw new FocusError(`Long breaks come every ${MIN_LONG_BREAK_EVERY} to ${MAX_LONG_BREAK_EVERY} runs`);
    }
    setSetting(db, LONG_BREAK_EVERY_KEY, String(patch.longBreakEvery));
  }
  if (patch.mode !== undefined) {
    if (!(FOCUS_MODES as readonly string[]).includes(patch.mode)) throw new FocusError(`A rhythm is ${FOCUS_MODES.join(" or ")}`);
    setSetting(db, MODE_KEY, patch.mode);
  }
  return getFocusSettings(db);
}

/** Anything with `select`/`update`/`insert`/`delete` — `db` itself, or the `tx` handle inside a
 * transaction. Drizzle's transaction handle is not a `DB` (it carries no `$client`), so the row
 * helpers below take this instead and work identically either way. */
type Executor = Pick<DB, "select" | "update" | "insert" | "delete">;

/** The live run, if there is one. Ordered so that if the "at most one" invariant the partial
 * unique index enforces were ever somehow violated, reads are still deterministic rather than
 * picking whichever row SQLite happens to return first. */
function liveRow(db: Executor): FocusRun | undefined {
  return db.select().from(focusRuns).where(isNull(focusRuns.endedAt)).orderBy(asc(focusRuns.id)).get();
}

/**
 * The one place a run is ever closed — every rule about what a run's minutes mean lives here, so
 * no caller can bypass it and no two callers can disagree about it:
 *
 * - Under `ABANDON_UNDER` minutes is a mis-click, not work: it is abandoned whatever it was
 *   called, and books nothing.
 * - Past the run's planned end by more than `STALE_AFTER`, the run closes at the end it was
 *   *meant* to have, as "completed", regardless of how late the caller's own clock reads — a
 *   laptop that slept mid-run and woke ten hours later must book the same minutes whether the
 *   stale run was found by a background read (`runningFocus`) or by the tab finally posting its
 *   finish. After this there is no way, through any exported function, to book more than
 *   `plannedMinutes + STALE_AFTER` against a task.
 * - An explicit `"abandoned"` always wins over staleness: design §4.1 defines abandoned as ended
 *   under two minutes in *or discarded by the person*, and a person who comes back and discards a
 *   run they left running must still get 0 minutes booked, however late that discard call
 *   arrives. The staleness override above is only for a caller with no opinion, or one asking for
 *   `"stopped"`/`"completed"` — it is not license to overrule an explicit discard.
 * - "completed" means the clock reached zero, so it books exactly `plannedMinutes` — never a
 *   rounded wall-clock figure, so an on-time finish a few seconds late does not round up past
 *   what was planned. "stopped" keeps the rounded wall-clock time: that is what "ended early with
 *   the minutes kept" means.
 */
function closeRow(db: Executor, run: FocusRun, outcome: FocusOutcome, now: Date): FocusRun {
  const start = Date.parse(run.startedAt);
  if (now.getTime() < start) throw new FocusError("A run cannot end before it started");
  const plannedEnd = start + run.plannedMinutes * 60_000;
  const stale = now.getTime() - plannedEnd > STALE_AFTER * 60_000;
  // A stale run is forced to "completed" at its planned end — unless the caller explicitly
  // discarded it, which must survive however late that call arrives.
  const forceCompleted = stale && outcome !== "abandoned";
  const endAt = forceCompleted ? new Date(plannedEnd) : now;
  const ran = Math.max(0, Math.round((endAt.getTime() - start) / 60_000));
  const settled: FocusOutcome = forceCompleted ? "completed" : ran < ABANDON_UNDER || outcome === "abandoned" ? "abandoned" : outcome;
  const actualMinutes = settled === "abandoned" ? 0 : settled === "completed" ? run.plannedMinutes : ran;
  const row = db
    .update(focusRuns)
    .set({ endedAt: endAt.toISOString(), actualMinutes, outcome: settled })
    .where(eq(focusRuns.id, run.id))
    .returning()
    .get();
  if (!row) throw new FocusError("Focus run not found", 404);
  return row;
}

/** Starts a run, on a task or on nothing. Length is chosen in the order design §4.2 lays out: an explicit
 * `minutes` first, then the named block's own length, then the saved default for a run with no
 * session behind it at all. Starting stops whatever run is currently live, in the same
 * transaction: there is only ever one run at a time, and the incumbent keeps whatever it has
 * actually run rather than losing it to a race. */
export function startFocus(db: DB, input: { taskId?: number | null; blockId?: number | null; minutes?: number }, now = new Date()): FocusRun {
  // No task is a run on nothing in particular, not a missing argument: the timer does not require
  // the work to already be written down. A task that was *named* still has to exist.
  const taskId = input.taskId ?? null;
  if (taskId !== null && !getTask(db, taskId)) throw new FocusError("Task not found", 404);
  let block: TaskBlock | undefined;
  if (input.blockId != null) {
    // A block names the session this run's length is meant to come from (design §4.2): one that
    // does not exist, or belongs to a different task, is a silent mis-attribution, not a run.
    block = getBlock(db, input.blockId);
    if (!block) throw new FocusError("Session not found", 404);
    if (taskId === null) throw new FocusError("A session belongs to a task, so name the task too");
    if (block.taskId !== taskId) throw new FocusError("That session belongs to a different task");
  }
  const minutes = input.minutes ?? block?.minutes ?? getFocusSettings(db).defaultMinutes;
  if (!Number.isInteger(minutes) || minutes < MIN_FOCUS_MINUTES || minutes > MAX_FOCUS_MINUTES) {
    throw new FocusError(`A run is ${MIN_FOCUS_MINUTES} to ${MAX_FOCUS_MINUTES} minutes`);
  }
  return db.transaction((tx) => {
    const live = liveRow(tx);
    if (live) {
      // A clock that has stepped backwards must not fail an unrelated new-run request: clamp the
      // incumbent's close to no earlier than its own start, rather than let closeRow's guard
      // (rightly strict for a caller naming its own run in finishFocus) reject this one instead.
      const stopAt = new Date(Math.max(now.getTime(), Date.parse(live.startedAt)));
      closeRow(tx, live, "stopped", stopAt);
    }
    const row = tx
      .insert(focusRuns)
      .values({ taskId, blockId: input.blockId ?? null, startedAt: now.toISOString(), plannedMinutes: minutes })
      .returning()
      .get();
    if (!row) throw new Error("Insert returned no row");
    return row;
  });
}

/** Finishes a live run with the outcome the caller names — `closeRow` may still override it,
 * to "abandoned" when too little time passed, or to "completed" when the run is long stale. */
export function finishFocus(db: DB, id: number, outcome: FocusOutcome, now = new Date()): FocusRun {
  const row = db.select().from(focusRuns).where(eq(focusRuns.id, id)).get();
  if (!row) throw new FocusError("Focus run not found", 404);
  if (row.endedAt !== null) throw new FocusError("Focus run already finished");
  return closeRow(db, row, outcome, now);
}

/**
 * The live run, if there is one. A browser closed mid-run leaves the row open forever, so this
 * reconciles it through the same `closeRow` every other close goes through — the only thing owned
 * here is the decision of *whether* to close at all: past the grace period, yes; inside it, the
 * run is simply still live and is returned as-is.
 */
export function runningFocus(db: DB, now = new Date()): FocusRun | null {
  const live = liveRow(db);
  if (!live) return null;
  const plannedEnd = Date.parse(live.startedAt) + live.plannedMinutes * 60_000;
  if (now.getTime() - plannedEnd <= STALE_AFTER * 60_000) return live;
  closeRow(db, live, "completed", now);
  return null;
}

/** Minutes actually run, per task, for runs that booked anything at all — an abandoned run is
 * never in this map, not even at zero. Consumed by `serializeTasks`/`serializePlanTasks` in
 * `src/lib/api.ts`, which feed `spentMinutes` into every `TaskDTO`/`PlanTaskDTO`. */
export function focusMinutesByTask(db: DB, taskIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (taskIds.length === 0) return out;
  const rows = db
    .select({ taskId: focusRuns.taskId, minutes: focusRuns.actualMinutes })
    .from(focusRuns)
    .where(and(inArray(focusRuns.taskId, taskIds), isNotNull(focusRuns.actualMinutes), ne(focusRuns.outcome, "abandoned")))
    .all();
  // `inArray` above already restricts this to the task ids asked for, so a null cannot be among
  // them -- the guard is for the type, not for a case that can happen.
  for (const row of rows) {
    if (row.taskId === null) continue;
    out.set(row.taskId, (out.get(row.taskId) ?? 0) + (row.minutes ?? 0));
  }
  return out;
}

/**
 * Minutes actually run against each named session — what a box on the timeline cost, against the
 * length it was promised. The same shape and the same rules as `focusMinutesByTask` one query up:
 * an abandoned run is never in this map, and a session nothing ran against is simply absent.
 */
export function focusMinutesByBlock(db: DB, blockIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (blockIds.length === 0) return out;
  const rows = db
    .select({ blockId: focusRuns.blockId, minutes: focusRuns.actualMinutes })
    .from(focusRuns)
    .where(and(inArray(focusRuns.blockId, blockIds), isNotNull(focusRuns.actualMinutes), ne(focusRuns.outcome, "abandoned")))
    .all();
  for (const row of rows) {
    if (row.blockId === null) continue;
    out.set(row.blockId, (out.get(row.blockId) ?? 0) + (row.minutes ?? 0));
  }
  return out;
}

/**
 * Estimate against actual, one pair per finished task, for `driftFactor` to read the person's
 * own history from — the outside view design §4.1 wants instead of the imagined multiple. Only
 * a `done` task with an estimate on it and at least one run that booked minutes counts; its
 * actual is the sum of every run's booked minutes, never just the last one, so a task worked in
 * several sessions is not read as finished faster than it was. One grouped query, newest
 * completion first, so a caller wanting the most recent `limit` pairs never has to query per
 * task to get them.
 */
export function estimateActualPairs(db: DB, limit = DRIFT_WINDOW): Pair[] {
  const rows = db
    .select({ estimateMinutes: tasks.estimateMinutes, actualMinutes: sql<number>`sum(${focusRuns.actualMinutes})` })
    .from(tasks)
    .innerJoin(focusRuns, eq(focusRuns.taskId, tasks.id))
    .where(
      and(
        eq(tasks.status, "done"),
        isNotNull(tasks.estimateMinutes),
        gt(tasks.estimateMinutes, 0),
        isNotNull(focusRuns.actualMinutes),
        gt(focusRuns.actualMinutes, 0),
        ne(focusRuns.outcome, "abandoned"),
      ),
    )
    .groupBy(tasks.id)
    .orderBy(desc(tasks.completedAt))
    .limit(limit)
    .all();
  return rows.map((row) => ({ estimateMinutes: row.estimateMinutes!, actualMinutes: Number(row.actualMinutes) }));
}

/** How many word-sharing, done-and-booked tasks a "like this" figure needs before it is shown —
 * below this a match is a coincidence, not a pattern, and a wrong hint in front of an
 * unestimated task is worse than none (design's own words). */
export const LIKE_THIS_MIN_MATCHES = 3;
/** How many of a container's newest matches feed the median — recent work says more about what
 * a task takes now than one finished a year ago. */
const LIKE_THIS_LIMIT = 20;
// `significantWords`/`shareWord` (the four-letter-or-more shared-word rule) now live in
// `@/lib/significant-words`, shared with `@/domain/containers/suggest` (review F4) rather than
// copied here.

/** The middle of a sorted list of minutes — one runaway session says something about that task,
 * not about the next one shaped like it. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per task id, what finished work like it actually took: the median booked minutes of every
 * `done` task in the same container whose title shares a meaningful word (four letters or more,
 * lowercased) with this one — newest completion first, each task's own matches capped at
 * `limit`. Null below `LIKE_THIS_MIN_MATCHES` matches, or with no container to match against at
 * all: deliberately dull matching, because anything cleverer is a guess dressed as an insight
 * (spec).
 *
 * One query for every candidate in every container the whole list touches — the same shape
 * `focusMinutesByTask` and `goalRefsByContainer` already batch — with the per-task matching, the
 * word-sharing filter and the `limit` slice, done in memory afterward, so a fifty-task list
 * costs this one query, never one per row. The query itself carries no `.limit()` and is not
 * capped — it reads every finished, booked task across every container the list touches, because
 * which twenty are newest differs per task, so the cap has to be applied per task in memory
 * rather than on the row set the query returns (honest-forecast review F7).
 */
export function likeThisMinutesByTask(
  db: DB,
  list: { id: number; title: string; containerId: number | null }[],
  limit = LIKE_THIS_LIMIT,
): Map<number, number | null> {
  const out = new Map<number, number | null>(list.map((t) => [t.id, null]));
  const containerIds = [...new Set(list.map((t) => t.containerId).filter((id): id is number => id !== null))];
  if (containerIds.length === 0) return out;

  const rows = db
    .select({ taskId: tasks.id, containerId: tasks.containerId, title: tasks.title, actualMinutes: sql<number>`sum(${focusRuns.actualMinutes})` })
    .from(tasks)
    .innerJoin(focusRuns, eq(focusRuns.taskId, tasks.id))
    .where(
      and(
        inArray(tasks.containerId, containerIds),
        eq(tasks.status, "done"),
        isNotNull(focusRuns.actualMinutes),
        gt(focusRuns.actualMinutes, 0),
        ne(focusRuns.outcome, "abandoned"),
      ),
    )
    .groupBy(tasks.id)
    .orderBy(desc(tasks.completedAt))
    .all();

  const byContainer = new Map<number, { taskId: number; title: string; actualMinutes: number }[]>();
  for (const row of rows) {
    const containerId = row.containerId!;
    const entry = { taskId: row.taskId, title: row.title, actualMinutes: Number(row.actualMinutes) };
    const bucket = byContainer.get(containerId);
    if (bucket) bucket.push(entry);
    else byContainer.set(containerId, [entry]);
  }

  for (const t of list) {
    if (t.containerId === null) continue;
    const candidates = byContainer.get(t.containerId);
    if (!candidates) continue;
    const words = significantWords(t.title);
    if (words.size === 0) continue;
    const matches = candidates
      .filter((c) => c.taskId !== t.id && shareWord(words, significantWords(c.title)))
      .slice(0, limit)
      .map((c) => c.actualMinutes)
      .sort((a, b) => a - b);
    if (matches.length < LIKE_THIS_MIN_MATCHES) continue;
    out.set(t.id, Math.round(median(matches)));
  }
  return out;
}

/**
 * The single-task read `likeThisMinutesByTask` batches — a convenience for a caller holding one
 * task, such as a test or a one-off lookup. Never call this from a loop over a list: that would
 * turn the one query above back into one per row, exactly the shape three reviews on this
 * branch have flagged.
 */
export function similarActualMinutes(db: DB, task: { id: number; title: string; containerId: number | null }, limit = LIKE_THIS_LIMIT): number | null {
  return likeThisMinutesByTask(db, [task], limit).get(task.id) ?? null;
}

export interface FocusSummary {
  minutes: number;
  runs: number;
  byTask: { taskId: number; title: string; minutes: number; runs: number }[];
}

/**
 * Booked minutes over `[from, to)`, both local days, by the day a run *started* — a run is work
 * done then, not work discovered now, so a run that crossed into `to` while it was running still
 * counts against the day it began. Reconciles a stale live run first, the same as `runningFocus`,
 * so a summary read right after a browser closed mid-run is not missing what it actually did.
 */
export function focusSummary(db: DB, range: { from: string; to: string }, now = new Date()): FocusSummary {
  runningFocus(db, now);
  // Left-joined, not inner: a run started on nothing in particular is still focused work and
  // still belongs in `minutes` and `runs`. It has no row in `byTask`, which is a breakdown of
  // time by task and cannot invent one for time that was not about a task.
  const rows = db
    .select({ taskId: focusRuns.taskId, title: tasks.title, startedAt: focusRuns.startedAt, minutes: focusRuns.actualMinutes })
    .from(focusRuns)
    .leftJoin(tasks, eq(tasks.id, focusRuns.taskId))
    .where(and(gte(focusRuns.startedAt, dayBounds(range.from).start), isNotNull(focusRuns.actualMinutes), ne(focusRuns.outcome, "abandoned")))
    .all()
    .filter((row) => {
      const day = localDay(row.startedAt);
      return day >= range.from && day < range.to;
    });

  const byTask = new Map<number, { taskId: number; title: string; minutes: number; runs: number }>();
  let minutes = 0;
  let runs = 0;
  for (const row of rows) {
    const m = row.minutes ?? 0;
    minutes += m;
    runs += 1;
    if (row.taskId === null) continue;
    const entry = byTask.get(row.taskId) ?? { taskId: row.taskId, title: row.title ?? "", minutes: 0, runs: 0 };
    entry.minutes += m;
    entry.runs += 1;
    byTask.set(row.taskId, entry);
  }
  return { minutes, runs, byTask: [...byTask.values()].sort((a, b) => b.minutes - a.minutes || a.taskId - b.taskId) };
}

/** How many runs finished "completed" on that local day, by when they started — what the
 * long-break rule counts against. */
export function completedToday(db: DB, date: string): number {
  const rows = db
    .select({ startedAt: focusRuns.startedAt })
    .from(focusRuns)
    .where(and(gte(focusRuns.startedAt, dayBounds(date).start), eq(focusRuns.outcome, "completed")))
    .all();
  return rows.filter((r) => localDay(r.startedAt) === date).length;
}

/** Every local day `[startedAt, endedAt]` touches, inclusive — almost always one day, but a run
 * crossing local midnight touches two. */
function daysTouched(startedAt: string, endedAt: string): string[] {
  const days: string[] = [];
  for (let d = localDay(startedAt), last = localDay(endedAt); ; d = addDays(d, 1)) {
    days.push(d);
    if (d >= last) break;
  }
  return days;
}

/**
 * Where the machine actually was while the run was live: every non-AFK session on every local day
 * the run touches, clipped to the run's own window and ranked by `topApps` — the same "name a
 * browser by its busiest domain" rule `activityToday` (src/lib/home.ts) uses, shared from
 * `@/domain/activity` so there is only one copy of it. `[]` when the helper never reported
 * anything for the run's window (whether because it never reported at all, or because nothing it
 * did report overlaps this particular run), and for a run with no end yet.
 */
export function focusWhere(db: DB, run: FocusRun): { label: string; ms: number }[] {
  if (!run.endedAt) return [];
  const runStart = Date.parse(run.startedAt);
  const runEnd = Date.parse(run.endedAt);
  const overlapping = daysTouched(run.startedAt, run.endedAt)
    .flatMap((day) => getDay(db, day).sessions)
    .filter((s) => !s.afk)
    .map((s) => {
      const start = Math.max(runStart, Date.parse(s.startedAt));
      const end = Math.min(runEnd, Date.parse(s.endedAt));
      return { appId: s.appId, appName: s.appName, domain: s.domain, ms: end - start };
    })
    .filter((s) => s.ms > 0);
  return topApps(overlapping, FOCUS_WHERE_LIMIT);
}
