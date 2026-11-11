import { and, asc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import type { DB } from "@/db/client";
import { containers, dailyPlanEntries, tasks, type CalendarEvent, type Task } from "@/db/schema";
import { dayBounds, listMeetings } from "@/domain/activity";
import { listContainers } from "@/domain/containers";
import { focusSummary } from "@/domain/focus";
import { goalsWithMeasure } from "@/domain/goals";
import { countInbox } from "@/domain/items";
import { type PlanTask } from "@/domain/plan";
import { getReview, nextStep, reviewAnswers, reviewSavedAt, reviewSnapshot, type ReviewSnapshot } from "@/domain/review";
import { listPredictions } from "@/domain/predictions";
import { containerProgress, listTasks, MINE } from "@/domain/tasks";
import { localDay } from "./time";
import { nextWeek, weekDays, weekEnd, weekLabel, weekStart } from "./week";
import { serializeGoal, serializeMeetings, serializePlanTasks, serializeTasks } from "./api";
import type { ContainerRefDTO, ReviewDTO } from "./dto";

/** A meeting a person is actually going to be at: not declined, and not all-day — the same rule
 * `homePayload` (src/lib/home.ts) counts by. Both read `listMeetings`, which selects on the
 * calendar day column, so a meeting crossing local midnight is attributed to the day it starts
 * on here exactly as it is there. */
function isCountableMeeting(ev: CalendarEvent): boolean {
  return ev.allDay !== 1 && ev.status !== "declined";
}

function toContainerRef(c: { id: number; name: string; slug: string; kind: ContainerRefDTO["kind"] }): ContainerRefDTO {
  return { id: c.id, name: c.name, slug: c.slug, kind: c.kind };
}

/**
 * The still-open tasks planned on any day of the week, each counted once however many of the
 * week's days it sits on — a task planned Monday and carried to Tuesday is one thing left open,
 * not two. `clear.leftover` and `back.slipped` both read this same set, as rows and as a count,
 * so on the week being lived they cannot drift apart the way a second query for either
 * would risk. On a past week they can and should: `back` comes from the frozen snapshot and
 * says what was open when the prose was written, while `clear.leftover` stays live because
 * a carry or a drop acts on the task as it is now.
 *
 * One query across all seven days rather than `listPlan` called once per day: the join and the
 * `status = "open"` filter both run in SQL, and the per-task dedup is the only work left to JS.
 */
function weekLeftover(db: DB, days: string[]): PlanTask[] {
  const rows = db
    .select({ task: tasks, planId: dailyPlanEntries.id, sortOrder: dailyPlanEntries.sortOrder })
    .from(dailyPlanEntries)
    .innerJoin(tasks, eq(tasks.id, dailyPlanEntries.taskId))
    .where(and(inArray(dailyPlanEntries.date, days), eq(tasks.status, "open")))
    .orderBy(asc(dailyPlanEntries.date), asc(dailyPlanEntries.sortOrder), asc(dailyPlanEntries.id))
    .all();
  const byId = new Map<number, PlanTask>();
  for (const row of rows) {
    if (!byId.has(row.task.id)) byId.set(row.task.id, { ...row.task, planId: row.planId, sortOrder: row.sortOrder });
  }
  return [...byId.values()];
}

/** Tasks completed inside `[week, end)`, bounded on `completedAt` at both ends — the same two
 * boundaries `focusSummary` (src/domain/focus/index.ts) reads its own range by. Bounding only the
 * lower end (as an earlier version of this function did, off `updatedAt`) let a task completed
 * weeks earlier and merely edited inside this week count as done this week; both ends closed on
 * the field that actually answers "done when" rules that out. */
function doneInWeek(db: DB, week: string, end: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(and(MINE, eq(tasks.status, "done"), isNotNull(tasks.completedAt), gte(tasks.completedAt, dayBounds(week).start), lt(tasks.completedAt, dayBounds(end).start)))
    .all();
}

/** Tasks dropped inside `[week, end)`, bounded on `droppedAt` at both ends — its own column,
 * set by `dropTask` and cleared by `reopenTask`/`completeTask`, so unlike `updatedAt` it cannot
 * be moved into a different week by an unrelated later edit. */
function droppedInWeek(db: DB, week: string, end: string): Task[] {
  return db
    .select()
    .from(tasks)
    .where(and(MINE, eq(tasks.status, "dropped"), isNotNull(tasks.droppedAt), gte(tasks.droppedAt, dayBounds(week).start), lt(tasks.droppedAt, dayBounds(end).start)))
    .all();
}

/** The projects that closed something this week, each with how many and its overall percent —
 * the same figure `containerProgress` gives every project card, so a project's percent here and
 * on its own page can never read differently. */
function weekProjects(db: DB, done: Task[]): ReviewDTO["back"]["projects"] {
  const closedByContainer = new Map<number, number>();
  for (const t of done) {
    if (t.containerId === null) continue;
    closedByContainer.set(t.containerId, (closedByContainer.get(t.containerId) ?? 0) + 1);
  }
  const ids = [...closedByContainer.keys()];
  if (ids.length === 0) return [];
  const rows = db
    .select({ id: containers.id, name: containers.name, slug: containers.slug, kind: containers.kind })
    .from(containers)
    .where(inArray(containers.id, ids))
    .all();
  const progress = containerProgress(db, ids);
  return rows
    .map((c) => ({ container: toContainerRef(c), closed: closedByContainer.get(c.id) ?? 0, percent: progress.get(c.id)?.percent ?? 0 }))
    .sort((a, b) => b.closed - a.closed || a.container.name.localeCompare(b.container.name));
}

/** The snapshot's projects, resolved back into `ContainerRefDTO`s. The snapshot itself only
 * freezes `containerId`/`name`/`closed`/`percent` — `slug` and `kind` are read off the container
 * row as it stands today, since a link needs a real slug to resolve and neither one is a figure
 * the snapshot is trying to freeze. A container deleted since the snapshot was taken (rare: the
 * domain refuses to delete one with tasks) falls back to a slug of its own id, so the row still
 * renders rather than vanishing from a week that genuinely closed work against it. */
function snapshotProjects(db: DB, snapshot: ReviewSnapshot): ReviewDTO["back"]["projects"] {
  if (snapshot.projects.length === 0) return [];
  const ids = snapshot.projects.map((p) => p.containerId);
  const rows = db
    .select({ id: containers.id, name: containers.name, slug: containers.slug, kind: containers.kind })
    .from(containers)
    .where(inArray(containers.id, ids))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return snapshot.projects.map((p) => {
    const row = byId.get(p.containerId);
    const container: ContainerRefDTO = row ? toContainerRef(row) : { id: p.containerId, name: p.name, slug: String(p.containerId), kind: "project" };
    return { container, closed: p.closed, percent: p.percent };
  });
}

/**
 * The week's reps in the prediction log: calls made, and calls scored.
 *
 * `end` is the following Monday, so both bounds are days and the resolved side counts by
 * `resolvedAt` rather than by when the call was made — going back on Friday to score something
 * you called a month ago is the rep this is measuring, and it belongs to the week you did it in.
 */
function weekPredictions(db: DB, week: string, end: string): { logged: number; resolved: number } {
  const rows = listPredictions(db, { state: "all" });
  const inWeek = (at: string) => at >= week && at < end;
  return {
    logged: rows.filter((r) => inWeek(r.createdAt.slice(0, 10))).length,
    resolved: rows.filter((r) => r.resolvedAt !== null && inWeek(r.resolvedAt.slice(0, 10))).length,
  };
}

/**
 * The whole review payload for one week: the record it has written so far, and the figures the
 * four panes read. Every figure comes from the domain that already owns it — `countInbox` for
 * the inbox badge, `focusSummary` for booked time, `goalsWithMeasure` for goal progress, the same
 * meeting rule `homePayload` uses — so this and Home can never disagree about the same week.
 */
export function reviewPayload(db: DB, week: string, now: Date): ReviewDTO {
  const days = weekDays(week);
  const end = nextWeek(week);
  const window = { from: week, to: end };
  const today = localDay(now.toISOString());
  const current = week === weekStart(today);

  const item = getReview(db, week);
  const answers = item ? reviewAnswers(item) : {};
  const savedAt = reviewSavedAt(item);

  const leftover = weekLeftover(db, days);

  // A closed week's own review can carry a frozen snapshot of `back` in its meta (design §5.2)
  // — written at save time by whichever domain owns each figure. Once the week is no longer the
  // one in progress, that snapshot is what renders: a live re-query of `slipped` (still-open
  // tasks) drifts the moment those tasks are closed, and would otherwise silently rewrite what
  // the saved prose was written about. The current week always reads live, since it has nothing
  // yet to freeze against.
  const snapshot = !current && item ? reviewSnapshot(item) : undefined;

  const doneRows = snapshot ? [] : doneInWeek(db, week, end);
  const droppedRows = snapshot ? [] : droppedInWeek(db, week, end);
  const focus = snapshot ? { minutes: snapshot.focusMinutes, runs: snapshot.focusRuns } : focusSummary(db, window, now);
  const meetingCount = snapshot ? snapshot.meetings : listMeetings(db, window).filter(isCountableMeeting).length;

  // Reps, not scores: how many calls were logged in the week and how many were gone back to.
  // The three scores are over the whole log and would mean nothing cut to seven days.
  const weekCalls = snapshot ? (snapshot.predictions ?? { logged: 0, resolved: 0 }) : weekPredictions(db, week, end);

  const back: ReviewDTO["back"] = snapshot
    ? { done: snapshot.done, dropped: snapshot.dropped, slipped: snapshot.slipped, focusMinutes: focus.minutes, focusRuns: focus.runs, meetings: meetingCount, projects: snapshotProjects(db, snapshot), predictions: weekCalls, frozen: true }
    : { done: doneRows.length, dropped: droppedRows.length, slipped: leftover.length, focusMinutes: focus.minutes, focusRuns: focus.runs, meetings: meetingCount, projects: weekProjects(db, doneRows), predictions: weekCalls, frozen: false };

  // A week's movement cannot come from days it hasn't reached yet: a week still in progress is
  // measured as of today, and a week already closed is measured as of its own last day, never
  // as of "now" regardless of how long ago the week was (design §5.1's "movement for the week").
  const measureAsOf = current ? today : weekEnd(week);

  const ahead = end;
  const aheadEnd = nextWeek(ahead);
  const aheadWindow = { from: ahead, to: aheadEnd };
  const dueSoon = listTasks(db, { status: "open", dueOnOrBefore: weekEnd(ahead) }).filter((t) => t.dueDate !== null && t.dueDate >= ahead);
  const deadlines = listContainers(db, { kind: "project", status: "active" })
    .filter((c) => c.deadline !== null && c.deadline >= ahead && c.deadline < aheadEnd)
    .map((c) => ({ container: toContainerRef(c), deadline: c.deadline! }));
  const aheadMeetings = listMeetings(db, aheadWindow).filter(isCountableMeeting);

  return {
    week,
    label: weekLabel(week),
    days,
    today,
    asOf: measureAsOf,
    current,
    step: nextStep(answers),
    answers,
    clear: {
      inbox: countInbox(db),
      leftover: serializePlanTasks(db, leftover, window),
    },
    back,
    goals: goalsWithMeasure(db, { status: "active" }, measureAsOf).map(serializeGoal),
    ahead: {
      week: ahead,
      due: serializeTasks(db, dueSoon, aheadWindow),
      deadlines,
      meetings: serializeMeetings(db, aheadMeetings),
    },
    savedAt,
  };
}
