import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import type { DB } from "@/db/client";
import { dailyPlanEntries, taskBlocks, tasks, type Task, type TaskBlock } from "@/db/schema";
import { addDays, listMeetings } from "@/domain/activity";
import { effectiveDecision, seriesDecisionsFor } from "@/domain/meetings/decision";
import { getTask, requireMine, updateTask } from "@/domain/tasks";
import { meetingCost } from "@/lib/capacity";
import { freeSlots, placeSessions, SESSION_GAP, sessionsFor, type Span } from "@/lib/scheduler";
import { getWorkHours } from "@/lib/work-hours";

export class BlockError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "BlockError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TS = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const MIN_MINUTES = 5;
const MAX_MINUTES = 480;
/** The estimate's own ceiling: a sum of sessions past it never writes a length the task refuses. */
const MAX_ESTIMATE = 480;

function checkStartsAt(v: string): void {
  if (!LOCAL_TS.test(v) || Number.isNaN(Date.parse(v))) throw new BlockError("A session start is YYYY-MM-DDTHH:MM:SS in local time", 400);
}

function checkMinutes(n: number): void {
  if (!Number.isInteger(n) || n < MIN_MINUTES || n > MAX_MINUTES) throw new BlockError(`A session is between ${MIN_MINUTES} and ${MAX_MINUTES} minutes`, 400);
}

function checkDate(date: string): void {
  if (!DATE_RE.test(date)) throw new BlockError("A date is YYYY-MM-DD", 400);
}

/**
 * Both `addBlock` and `appendBlock` come through here, which is why the ownership rule lives
 * here rather than in each of them: hours on the timeline are hours of my day, and giving them
 * to work somebody else owns is the same lie as planning it.
 */
function requireTask(db: DB, id: number): Task {
  if (!getTask(db, id)) throw new BlockError(`Task ${id} not found`, 404);
  return requireMine(db, id);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local day a timestamp falls on. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * A local timestamp for `minutesOfDay` on `date`. The domain keeps its own copy rather than
 * reaching into the timeline's math: the same clock rules, no dependency on a component.
 */
function minutesToIso(date: string, minutesOfDay: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(y, m - 1, d, 0, minutesOfDay, 0, 0);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:00`;
}

/** Minutes from local midnight of `date` to the timestamp; a span from another day reads past the ends. */
function minutesInto(date: string, iso: string): number {
  return Math.round((new Date(iso).getTime() - new Date(`${date}T00:00:00`).getTime()) / 60_000);
}

/** The local day of `now`, the one a placement must not put sessions before. */
function localToday(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Sessions starting on `date`, as a range over the sorted start rather than a pattern match:
 * an index can answer a range, and no part of a date is ever read as a wildcard. */
function onDay(date: string) {
  return and(gte(taskBlocks.startsAt, `${date}T00:00:00`), lt(taskBlocks.startsAt, `${addDays(date, 1)}T00:00:00`))!;
}

/** Sessions starting in `[from, to)`, by date; the same range, over as many days as asked for. */
function inWindow(window: { from: string; to: string }) {
  return and(gte(taskBlocks.startsAt, `${window.from}T00:00:00`), lt(taskBlocks.startsAt, `${window.to}T00:00:00`))!;
}

export function listBlocks(db: DB, filter: { taskId?: number; date?: string } = {}): TaskBlock[] {
  const conds = [];
  if (filter.taskId !== undefined) conds.push(eq(taskBlocks.taskId, filter.taskId));
  if (filter.date !== undefined) conds.push(onDay(filter.date));
  return db
    .select()
    .from(taskBlocks)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(taskBlocks.startsAt), asc(taskBlocks.id))
    .all();
}

/**
 * Every listed task's sessions in one query, each list ordered by start. `window` bounds what
 * a payload carries: a task may hold sessions on any number of days, and a page that draws one
 * day, or one week, has no use for the rest of its history.
 */
export function blocksByTask(db: DB, taskIds: number[], window?: { from: string; to: string }): Map<number, TaskBlock[]> {
  const out = new Map<number, TaskBlock[]>(taskIds.map((id) => [id, []]));
  if (taskIds.length === 0) return out;
  const conds = [inArray(taskBlocks.taskId, taskIds)];
  if (window) conds.push(inWindow(window));
  const rows = db
    .select()
    .from(taskBlocks)
    .where(and(...conds))
    .orderBy(asc(taskBlocks.startsAt), asc(taskBlocks.id))
    .all();
  for (const row of rows) out.get(row.taskId)?.push(row);
  return out;
}

export function getBlock(db: DB, id: number): TaskBlock | undefined {
  return db.select().from(taskBlocks).where(eq(taskBlocks.id, id)).get();
}

export function addBlock(db: DB, input: { taskId: number; startsAt: string; minutes: number }): TaskBlock {
  requireTask(db, input.taskId);
  checkStartsAt(input.startsAt);
  checkMinutes(input.minutes);
  const row = db.insert(taskBlocks).values({ taskId: input.taskId, startsAt: input.startsAt, minutes: input.minutes }).returning().get();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

/**
 * One more session of `minutes` for the task, in the first free time on `date` at or after now —
 * what "another box" means when a timebox is up and the work is not.
 *
 * Nothing else about the day moves. `placeTask` lays a task's whole day out from scratch, which
 * is the wrong answer here: the boxes already run are history, and the ones still ahead were put
 * where they are on purpose. `minSlot` is the box's own length, so the slot found has room for
 * the whole of it and `placeSessions` never splits it across two — a box cut in half is not a
 * box.
 */
export function appendBlock(db: DB, input: { taskId: number; minutes: number; date: string; now?: Date }): TaskBlock {
  requireTask(db, input.taskId);
  checkDate(input.date);
  checkMinutes(input.minutes);
  const now = input.now ?? new Date();
  const notBefore = input.date === localToday(now) ? now.getHours() * 60 + now.getMinutes() : undefined;
  const slots = freeSlots(busySpans(db, input.date), getWorkHours(db), { notBefore, minSlot: input.minutes });
  const { placed } = placeSessions(slots, [input.minutes], { floor: input.minutes });
  if (placed.length === 0) throw new BlockError(`No ${input.minutes} free minutes left that day`, 409);
  return addBlock(db, { taskId: input.taskId, startsAt: minutesToIso(input.date, placed[0].start), minutes: input.minutes });
}

/**
 * The estimate is the total, so it may not sit under the day's sessions: a session resized past
 * it pulls it up to their sum. An estimate nobody has guessed stays unguessed.
 */
/** The day's sessions are a floor for the estimate: a task nobody estimated takes their sum as
 * its estimate, and one estimated too low grows to match. Past eight hours the estimate stays
 * at its own ceiling and the sessions simply exceed it. */
function growEstimate(db: DB, taskId: number, date: string): void {
  const task = getTask(db, taskId);
  if (!task) return;
  const sum = listBlocks(db, { taskId, date }).reduce((n, b) => n + b.minutes, 0);
  if (task.estimateMinutes === null || sum > task.estimateMinutes) updateTask(db, taskId, { estimateMinutes: Math.min(MAX_ESTIMATE, sum) });
}

export function updateBlock(db: DB, id: number, patch: { startsAt?: string; minutes?: number }): TaskBlock {
  const current = getBlock(db, id);
  if (!current) throw new BlockError(`Session ${id} not found`, 404);
  const set: Partial<typeof taskBlocks.$inferInsert> = {};
  if (patch.startsAt !== undefined) {
    checkStartsAt(patch.startsAt);
    set.startsAt = patch.startsAt;
  }
  if (patch.minutes !== undefined) {
    checkMinutes(patch.minutes);
    set.minutes = patch.minutes;
  }
  const row = Object.keys(set).length ? db.update(taskBlocks).set(set).where(eq(taskBlocks.id, id)).returning().get() : current;
  if (!row) throw new BlockError(`Session ${id} not found`, 404);
  growEstimate(db, row.taskId, dayOf(row.startsAt));
  return row;
}

export function removeBlock(db: DB, id: number): void {
  const res = db.delete(taskBlocks).where(eq(taskBlocks.id, id)).run();
  if (res.changes === 0) throw new BlockError(`Session ${id} not found`, 404);
}

/** Takes the task's sessions off one day, or off every day when no date is given; returns how many went. */
export function clearBlocks(db: DB, taskId: number, date?: string): number {
  const where = date === undefined ? eq(taskBlocks.taskId, taskId) : and(eq(taskBlocks.taskId, taskId), onDay(date));
  return db.delete(taskBlocks).where(where).run().changes;
}

/**
 * What the day is already spoken for: timed meetings the person is actually going to (or has not
 * yet said otherwise about), and every session on it a live task holds. A dropped task gives its
 * hours back — `dropTask` takes its sessions away, and this skips them besides, so a row left
 * behind by an older write or by a hand-edited database never blocks a slot.
 *
 * A meeting blocks exactly the minutes `meetingCost` charges it against the capacity line, not
 * its whole clock length: the capacity figure and the scheduler must never disagree about the same
 * hour, and `meetingCost` is the one rule that decides what an hour of meeting actually costs.
 * That falls out to three behaviours, all of them `freeMinutes`'s own, none of them restated here:
 * a `going` meeting blocks its full length; a `not-going` meeting — regardless of what the
 * calendar's own RSVP still says — costs nothing and so blocks nothing, its zero-length span
 * dropped before it reaches `freeSlots`; a `maybe` meeting costs half, so it blocks half, leaving
 * the back half of the hour placeable. Before this the `maybe` case was the one disagreement left:
 * the hour was blocked whole while capacity reported half of it free, so "Fill the day" could
 * leave a genuinely available half-hour unplaced.
 *
 * The blocked half is taken from the *start* of the meeting, which is also what keeps a `maybe`
 * sitting on top of a `going` meeting from freeing anything: its half span falls inside the going
 * meeting's own, and `freeSlots` merges them — the same "an overlapping maybe adds nothing over
 * time already fully spoken for" rule `freeMinutes` reaches through `outsideCover`.
 *
 * `effectiveDecision`, not `effectiveDecisionAsOf`, and this is *not* because a day still being
 * planned has no past occurrence to protect — it can, once a meeting already under way is being
 * scheduled around, and an earlier version of this comment claimed otherwise (second final
 * whole-branch review, priority 2/6). `setMeetingDecision` guarantees an already-started
 * occurrence always carries its own explicit `decision` override the moment a series decision is
 * made *from that occurrence itself* — so for the row someone actually declined from,
 * `effectiveDecision` and `effectiveDecisionAsOf` agree regardless of `decidedAt`, which is what
 * this file relies on. That guarantee does not reach a *sibling* occurrence of the same series
 * that is also already under way but was not itself decided from: if the decision was made from a
 * different, not-yet-started occurrence instead, an under-way sibling keeps no override, and the
 * two resolvers can still disagree on it exactly as they did before this fix (recorded in
 * `docs/superpowers/follow-ups.md`, not fixed here — narrower and rarer than the case this fix
 * closed, since it needs two occurrences of the same series in progress or straddled by `now` at
 * once). Plain `effectiveDecision` is used here because it needs no series-decidedAt data at all,
 * not because the two functions are guaranteed to agree in every case.
 */
function busySpans(db: DB, date: string): Span[] {
  const events = listMeetings(db, { from: date, to: addDays(date, 1) });
  // One batched series-decision query for the day's events, not one per meeting.
  const seriesIds = [...new Set(events.map((ev) => ev.seriesId).filter((id): id is string => id !== null))];
  const decisions = seriesDecisionsFor(db, seriesIds);
  const meetings = events
    .filter((m) => m.allDay === 0)
    .map((m) => {
      const decision = effectiveDecision(m, m.seriesId ? (decisions.get(m.seriesId) ?? null) : null);
      const start = minutesInto(date, m.startsAt);
      return { start, end: start + meetingCost({ start, end: minutesInto(date, m.endsAt), decision }) };
    })
    .filter((s) => s.end > s.start);
  const blocks = db
    .select({ startsAt: taskBlocks.startsAt, minutes: taskBlocks.minutes })
    .from(taskBlocks)
    .innerJoin(tasks, eq(tasks.id, taskBlocks.taskId))
    .where(and(onDay(date), ne(tasks.status, "dropped")))
    .all()
    .map((b) => ({ start: minutesInto(date, b.startsAt), end: minutesInto(date, b.startsAt) + b.minutes }));
  return [...meetings, ...blocks];
}

/** One task's placement, without a transaction of its own: `placeTask` and `fillDay` own that. */
function place(db: DB, task: Task, date: string, now: Date, workHours: string): { placed: number; unplacedMinutes: number } {
  clearBlocks(db, task.id, date);
  const notBefore = date === localToday(now) ? now.getHours() * 60 + now.getMinutes() : undefined;
  const slots = freeSlots(busySpans(db, date), workHours, { notBefore });
  // Spec §3: a task's own sessions are not laid back to back — ten minutes stand between two
  // of them in the same slot. Nothing holds that break: the next task placed may take it.
  const { placed, leftover } = placeSessions(slots, sessionsFor(task.estimateMinutes, task.sessionMinutes), { gap: SESSION_GAP });
  for (const span of placed) {
    db.insert(taskBlocks).values({ taskId: task.id, startsAt: minutesToIso(date, span.start), minutes: span.end - span.start }).run();
  }
  return { placed: placed.length, unplacedMinutes: leftover };
}

/**
 * Lays the task's sessions into the day's free slots, dropping whatever it held there before.
 * Sessions on other days are none of this day's business and stay where they are.
 */
export function placeTask(db: DB, opts: { taskId: number; date: string; now?: Date }): { placed: number; unplacedMinutes: number } {
  const task = requireTask(db, opts.taskId);
  checkDate(opts.date);
  const workHours = getWorkHours(db);
  const now = opts.now ?? new Date();
  return db.transaction(() => place(db, task, opts.date, now, workHours));
}

/** The day's open plan tasks that hold no session on it yet, in plan order. */
function toFill(db: DB, date: string): Task[] {
  const blocked = new Set(listBlocks(db, { date }).map((b) => b.taskId));
  return db
    .select({ task: tasks })
    .from(dailyPlanEntries)
    .innerJoin(tasks, eq(tasks.id, dailyPlanEntries.taskId))
    .where(and(eq(dailyPlanEntries.date, date), eq(tasks.status, "open")))
    .orderBy(asc(dailyPlanEntries.sortOrder), asc(dailyPlanEntries.id))
    .all()
    .map((row) => row.task)
    .filter((t) => !blocked.has(t.id));
}

/** Places every open plan task that has no session on the day yet, in plan order. */
export function fillDay(db: DB, opts: { date: string; now?: Date }): { placed: number; unplacedMinutes: number } {
  checkDate(opts.date);
  const workHours = getWorkHours(db);
  const now = opts.now ?? new Date();
  return db.transaction(() => {
    let placed = 0;
    let unplacedMinutes = 0;
    for (const task of toFill(db, opts.date)) {
      const one = place(db, task, opts.date, now, workHours);
      placed += one.placed;
      unplacedMinutes += one.unplacedMinutes;
    }
    return { placed, unplacedMinutes };
  });
}
