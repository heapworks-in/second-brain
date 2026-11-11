import { and, asc, eq, inArray, isNotNull, isNull, like, lte, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { containers, dailyPlanEntries, items, people, tasks, type Task } from "@/db/schema";
import { clearBlocks } from "@/domain/blocks";
import type { TaskPriority, TaskStatus } from "@/db/enums";
import { guessStatus } from "@/domain/trackers/mapping";
import { localDay, nowIso } from "@/lib/time";

export class TaskError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

/**
 * My own work: `owner_person_id is null`.
 *
 * This exists as one exported expression rather than a convention because of what it guards. A
 * tracker is two hundred rows of which six are mine, and every surface in this app that means
 * "my work" -- the planner, Home's counts, the weekly review, three desk generators, the drift
 * figure -- read `tasks` directly. One of them forgetting the predicate does not fail loudly;
 * it quietly fills my week with other people's work. So the predicate is a thing you import,
 * and `src/domain/tasks/mine.test.ts` asserts each of those surfaces still uses it.
 *
 * Deliberately not "owned by a person whose name is mine": identity is a list of spellings in a
 * setting (`identity.names`), used once at import to decide which rows are mine. After that the
 * answer is a null, which cannot be mistyped.
 */
export const MINE = isNull(tasks.ownerPersonId);

export interface Progress {
  open: number;
  done: number;
  total: number;
  percent: number;
  nextTask: { id: number; title: string; dueDate: string | null } | null;
}

/** Who asked, however the caller happens to know it. An id is taken as given; a handle is
 * resolved against `people.slug` and quietly ignored when it matches nobody, which is what makes
 * `@typo` in the add-task box harmless. */
export interface RequesterInput {
  requesterPersonId?: number | null;
  requesterHandle?: string | null;
  /** The day they asked. Defaults to today the moment a requester lands on a task with none. */
  askedOn?: string | null;
}

/** The parts of a task that come from an imported sheet and go back out to one. Set by the
 * importer and the tracker page; absent everywhere else, where a task is not a row in a file. */
export interface SheetInput {
  trackerId?: number | null;
  theme?: string;
  parentLabel?: string;
  /** The status word humans read. Kept in step with `status` by `setStatus`, never independently. */
  statusLabel?: string;
  /** Columns of the sheet the mapping did not claim, verbatim. */
  sheetExtra?: Record<string, string>;
  sheetRow?: number | null;
}

export interface CreateTaskInput extends RequesterInput, SheetInput {
  title: string;
  /** Whose work it is; null (the default) means mine. */
  ownerPersonId?: number | null;
  /** Only the importer passes this: a sheet arrives with rows already finished. A row imported
   * as done gets no `completedAt`, because nobody knows when it was done and guessing would put
   * it in this week's review. */
  status?: TaskStatus;
  containerId?: number | null;
  dueDate?: string | null;
  priority?: TaskPriority;
  notes?: string;
  sourceItemId?: number | null;
  estimateMinutes?: number | null;
  sessionMinutes?: number | null;
}

export interface UpdateTaskInput extends RequesterInput, SheetInput {
  title?: string;
  /** Only the importer passes this; every other caller moves the lifecycle through
   * `completeTask`/`reopenTask`/`dropTask`. */
  status?: TaskStatus;
  ownerPersonId?: number | null;
  notes?: string;
  priority?: TaskPriority;
  dueDate?: string | null;
  containerId?: number | null;
  estimateMinutes?: number | null;
  sessionMinutes?: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ESTIMATE_MIN = 5;
const ESTIMATE_MAX = 480;
const SESSION_MIN = 15;
const SESSION_MAX = 480;

function checkEstimate(n: number | null | undefined): void {
  if (n == null) return;
  if (!Number.isInteger(n) || n < ESTIMATE_MIN || n > ESTIMATE_MAX) throw new TaskError(`An estimate is between ${ESTIMATE_MIN} and ${ESTIMATE_MAX} minutes`, 400);
}

/** How long each placed session should be; null leaves the sizing to the scheduler's default. */
function checkSessionMinutes(n: number | null | undefined): void {
  if (n == null) return;
  if (!Number.isInteger(n) || n < SESSION_MIN || n > SESSION_MAX) throw new TaskError(`A session is between ${SESSION_MIN} and ${SESSION_MAX} minutes`, 400);
}

function cleanTitle(title: string): string {
  const t = title.trim();
  if (!t) throw new TaskError("Title is required");
  return t;
}

function checkDate(d: string | null | undefined): void {
  if (d != null && !DATE_RE.test(d)) throw new TaskError("Due date must be YYYY-MM-DD");
}

function requireContainer(db: DB, id: number): void {
  if (!db.select({ id: containers.id }).from(containers).where(eq(containers.id, id)).get()) throw new TaskError(`Container ${id} not found`, 404);
}

function requireItem(db: DB, id: number): void {
  if (!db.select({ id: items.id }).from(items).where(eq(items.id, id)).get()) throw new TaskError(`Item ${id} not found`, 404);
}

function containerWhere(containerId: number | null) {
  return containerId === null ? isNull(tasks.containerId) : eq(tasks.containerId, containerId);
}

function nextSortOrder(db: DB, containerId: number | null): number {
  const row = db
    .select({ max: sql<number | null>`max(${tasks.sortOrder})` })
    .from(tasks)
    .where(containerWhere(containerId))
    .get();
  return row?.max == null ? 0 : Number(row.max) + 1;
}

function requirePerson(db: DB, id: number): void {
  if (!db.select({ id: people.id }).from(people).where(eq(people.id, id)).get()) throw new TaskError(`Person ${id} not found`, 404);
}

/**
 * The requester the input names, or `undefined` for "the caller said nothing about it".
 *
 * An unresolvable handle is also `undefined` rather than null: `@priya` typed when no Priya
 * exists must leave an existing requester alone, not clear it.
 */
function resolveRequester(db: DB, input: RequesterInput): number | null | undefined {
  if (input.requesterPersonId !== undefined) {
    if (input.requesterPersonId !== null) requirePerson(db, input.requesterPersonId);
    return input.requesterPersonId;
  }
  const handle = input.requesterHandle?.trim().toLowerCase();
  if (!handle) return undefined;
  const exact = db.select({ id: people.id }).from(people).where(eq(people.slug, handle)).get();
  if (exact) return exact.id;
  // Nobody types `@priya-raman`. A prefix resolves only while it names exactly one person: two
  // Priyas and the handle means nothing, which is better than meaning the wrong one.
  const prefixed = db.select({ id: people.id }).from(people).where(like(people.slug, `${handle}%`)).limit(2).all();
  return prefixed.length === 1 ? prefixed[0].id : undefined;
}

function requireTask(db: DB, id: number): Task {
  const row = getTask(db, id);
  if (!row) throw new TaskError(`Task ${id} not found`, 404);
  return row;
}

/**
 * Refuses a task that is somebody else's before it can be planned, blocked or run.
 *
 * The honest answer to "I want to work on Priya's row" is to take it over, not to put her name
 * on my timeline -- and a plan entry for work I am not doing makes the capacity line lie, which
 * is the one thing the planner must never do.
 */
export function requireMine(db: DB, taskId: number): Task {
  const task = requireTask(db, taskId);
  if (task.ownerPersonId !== null) {
    const owner = db.select({ name: people.name }).from(people).where(eq(people.id, task.ownerPersonId)).get();
    throw new TaskError(`That task is ${owner ? `${owner.name}'s` : "somebody else's"} -- take it over first to plan it`, 409);
  }
  return task;
}

export function createTask(db: DB, input: CreateTaskInput): Task {
  const title = cleanTitle(input.title);
  checkDate(input.dueDate);
  checkEstimate(input.estimateMinutes);
  checkSessionMinutes(input.sessionMinutes);
  const containerId = input.containerId ?? null;
  if (containerId !== null) requireContainer(db, containerId);
  const sourceItemId = input.sourceItemId ?? null;
  if (sourceItemId !== null) requireItem(db, sourceItemId);
  const now = nowIso();
  const requesterPersonId = resolveRequester(db, input) ?? null;
  const ownerPersonId = input.ownerPersonId ?? null;
  if (ownerPersonId !== null) requirePerson(db, ownerPersonId);
  checkDate(input.askedOn);
  const row = db
    .insert(tasks)
    .values({
      title,
      notes: input.notes ?? "",
      priority: input.priority ?? "normal",
      dueDate: input.dueDate ?? null,
      ownerPersonId,
      status: input.status ?? "open",
      trackerId: input.trackerId ?? null,
      theme: input.theme ?? "",
      parentLabel: input.parentLabel ?? "",
      statusLabel: input.statusLabel ?? "",
      sheetExtra: JSON.stringify(input.sheetExtra ?? {}),
      sheetRow: input.sheetRow ?? null,
      requesterPersonId,
      // A wait with no start cannot be measured, so the ask dates itself unless the caller knows
      // better. Null without a requester: a date with nobody attached says nothing.
      askedOn: requesterPersonId === null ? null : (input.askedOn ?? localDay(now)),
      containerId,
      sourceItemId,
      estimateMinutes: input.estimateMinutes ?? null,
      sessionMinutes: input.sessionMinutes ?? null,
      sortOrder: nextSortOrder(db, containerId),
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export function getTask(db: DB, id: number): Task | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

const STATUS_RANK = sql`case ${tasks.status} when 'open' then 0 when 'done' then 1 else 2 end`;

export function listTasks(
  db: DB,
  /** `dueOnOrBefore` also drops the undated: a SQL comparison against null is never true. */
  filter: {
    containerId?: number | null;
    status?: TaskStatus | "all";
    dueOnOrBefore?: string;
    sourceItemId?: number;
    requester?: number | "any";
    trackerId?: number;
    /** Whose work to list. Defaults to mine, so a caller that says nothing can never be the one
     * that floods a screen with a team's rows; `"anyone"` is how the tracker page asks for them. */
    owner?: "me" | "anyone" | number;
  } = {},
): Task[] {
  const conds = [];
  const owner = filter.owner ?? "me";
  if (owner === "me") conds.push(MINE);
  else if (typeof owner === "number") conds.push(eq(tasks.ownerPersonId, owner));
  if (filter.trackerId !== undefined) conds.push(eq(tasks.trackerId, filter.trackerId));
  if (filter.containerId !== undefined) conds.push(containerWhere(filter.containerId));
  const status = filter.status ?? "open";
  if (status !== "all") conds.push(eq(tasks.status, status));
  if (filter.dueOnOrBefore !== undefined) conds.push(lte(tasks.dueDate, filter.dueOnOrBefore));
  if (filter.sourceItemId !== undefined) conds.push(eq(tasks.sourceItemId, filter.sourceItemId));
  if (filter.requester !== undefined) conds.push(filter.requester === "any" ? isNotNull(tasks.requesterPersonId) : eq(tasks.requesterPersonId, filter.requester));
  return db
    .select()
    .from(tasks)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(STATUS_RANK, asc(tasks.sortOrder), asc(tasks.id))
    .all();
}

export function updateTask(db: DB, id: number, patch: UpdateTaskInput): Task {
  const current = requireTask(db, id);
  const set: Partial<typeof tasks.$inferInsert> = { updatedAt: nowIso() };
  if (patch.title !== undefined) set.title = cleanTitle(patch.title);
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.priority !== undefined) set.priority = patch.priority;
  if (patch.dueDate !== undefined) {
    checkDate(patch.dueDate);
    set.dueDate = patch.dueDate;
  }
  if (patch.containerId !== undefined && patch.containerId !== current.containerId) {
    if (patch.containerId !== null) requireContainer(db, patch.containerId);
    set.containerId = patch.containerId;
    set.sortOrder = nextSortOrder(db, patch.containerId);
  }
  if (patch.estimateMinutes !== undefined) {
    checkEstimate(patch.estimateMinutes);
    set.estimateMinutes = patch.estimateMinutes;
  }
  if (patch.sessionMinutes !== undefined) {
    checkSessionMinutes(patch.sessionMinutes);
    set.sessionMinutes = patch.sessionMinutes;
  }
  if (patch.ownerPersonId !== undefined && patch.ownerPersonId !== current.ownerPersonId) {
    if (patch.ownerPersonId !== null) requirePerson(db, patch.ownerPersonId);
    set.ownerPersonId = patch.ownerPersonId;
    // Handing work to somebody else takes my day back with it: a plan entry and the hours it
    // blocked are a claim about what I am doing, and that claim has just stopped being true.
    if (patch.ownerPersonId !== null) {
      db.delete(dailyPlanEntries).where(eq(dailyPlanEntries.taskId, id)).run();
      clearBlocks(db, id);
    }
  }
  if (patch.trackerId !== undefined) set.trackerId = patch.trackerId;
  if (patch.theme !== undefined) set.theme = patch.theme;
  if (patch.parentLabel !== undefined) set.parentLabel = patch.parentLabel;
  if (patch.statusLabel !== undefined) set.statusLabel = patch.statusLabel;
  if (patch.sheetExtra !== undefined) set.sheetExtra = JSON.stringify(patch.sheetExtra);
  if (patch.sheetRow !== undefined) set.sheetRow = patch.sheetRow;
  const requesterPersonId = resolveRequester(db, patch);
  if (requesterPersonId !== undefined) {
    set.requesterPersonId = requesterPersonId;
    // Clearing the requester clears the clock with it; naming one starts the clock today unless
    // the task already carried a date from an earlier ask.
    if (requesterPersonId === null) set.askedOn = null;
    else if (current.askedOn === null) set.askedOn = localDay(set.updatedAt as string);
  }
  if (patch.askedOn !== undefined) {
    checkDate(patch.askedOn);
    if (patch.askedOn !== null && (set.requesterPersonId ?? current.requesterPersonId) === null) throw new TaskError("Nobody is waiting on that task, so there is no wait to date", 400);
    set.askedOn = patch.askedOn;
  }
  const row = db.update(tasks).set(set).where(eq(tasks.id, id)).returning().get();
  if (!row) throw new TaskError(`Task ${id} not found`, 404);
  // A re-import can finish a row somebody ticked in the file. The lifecycle still moves through
  // `setStatus`, so dropping one still gives its hours back and `droppedAt` is still stamped.
  if (patch.status !== undefined && patch.status !== current.status) return setStatus(db, id, patch.status);
  return row;
}

/**
 * A dropped task is not going to happen, so it gives its hours back: every session it holds,
 * on every day, goes with it. Blocked time the plan can no longer use would otherwise keep
 * the next placement out of those slots.
 *
 * The import runs the other way round from the usual one — the blocks domain reads tasks —
 * but only inside this call, never while either module is being evaluated.
 */
/**
 * The word a sheet should now read, given where the lifecycle has moved.
 *
 * Only the ends are rewritten. "Blocked" and "On Hold" are both open and both worth keeping, so
 * reopening a row leaves its word alone unless that word claims the work is finished -- which,
 * after a reopen, it is not. A task that never came from a sheet has no word and gets none.
 */
function labelFor(current: Task, status: TaskStatus): string | undefined {
  if (current.trackerId === null && !current.statusLabel) return undefined;
  if (status === "done") return "Done";
  if (status === "dropped") return "Dropped";
  return guessStatus(current.statusLabel) === null ? undefined : "In Progress";
}

function setStatus(db: DB, id: number, status: TaskStatus): Task {
  const current = requireTask(db, id);
  const now = nowIso();
  const statusLabel = labelFor(current, status);
  return db.transaction(() => {
    const row = db
      .update(tasks)
      .set({ status, completedAt: status === "done" ? now : null, droppedAt: status === "dropped" ? now : null, ...(statusLabel === undefined ? {} : { statusLabel }), updatedAt: now })
      .where(eq(tasks.id, id))
      .returning()
      .get();
    if (!row) throw new TaskError(`Task ${id} not found`, 404);
    if (status === "dropped") clearBlocks(db, id);
    return row;
  });
}

export function completeTask(db: DB, id: number): Task {
  return setStatus(db, id, "done");
}

export function reopenTask(db: DB, id: number): Task {
  return setStatus(db, id, "open");
}

export function dropTask(db: DB, id: number): Task {
  return setStatus(db, id, "dropped");
}

export function deleteTask(db: DB, id: number): void {
  const res = db.delete(tasks).where(eq(tasks.id, id)).run();
  if (res.changes === 0) throw new TaskError(`Task ${id} not found`, 404);
}

/** Listed ids take positions 0..n-1 in order; the container's other open tasks follow in their current order. */
export function reorderTasks(db: DB, containerId: number | null, ids: number[]): Task[] {
  const open = listTasks(db, { containerId, status: "open" });
  const byId = new Map(open.map((t) => [t.id, t]));
  const listed = ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
  const listedIds = new Set(listed.map((t) => t.id));
  const ordered = [...listed, ...open.filter((t) => !listedIds.has(t.id))];
  const now = nowIso();
  db.transaction((tx) => {
    ordered.forEach((t, i) => tx.update(tasks).set({ sortOrder: i, updatedAt: now }).where(eq(tasks.id, t.id)).run());
  });
  return listTasks(db, { containerId, status: "open" });
}

function emptyProgress(): Progress {
  return { open: 0, done: 0, total: 0, percent: 0, nextTask: null };
}

/** Progress for many containers in two queries: counts grouped by container and status, then the first open task per container. */
export function containerProgress(db: DB, ids: number[]): Map<number, Progress> {
  const out = new Map<number, Progress>(ids.map((id) => [id, emptyProgress()]));
  if (ids.length === 0) return out;
  const counts = db
    .select({ containerId: tasks.containerId, status: tasks.status, c: sql<number>`count(*)` })
    .from(tasks)
    .where(and(inArray(tasks.containerId, ids), inArray(tasks.status, ["open", "done"])))
    .groupBy(tasks.containerId, tasks.status)
    .all();
  for (const row of counts) {
    if (row.containerId == null) continue;
    const p = out.get(row.containerId)!;
    if (row.status === "open") p.open = Number(row.c);
    else p.done = Number(row.c);
  }
  // Counted above across everybody: a project's percent done is the project's, and a tracker
  // whose rows are mostly other people's would otherwise read 100% while half of it is open.
  // What comes *next*, though, is advice to me, so it can only be my own work.
  const openTasks = db
    .select({ id: tasks.id, title: tasks.title, dueDate: tasks.dueDate, containerId: tasks.containerId, sortOrder: tasks.sortOrder })
    .from(tasks)
    .where(and(inArray(tasks.containerId, ids), eq(tasks.status, "open"), MINE))
    .orderBy(asc(tasks.sortOrder), sql`${tasks.dueDate} is null`, asc(tasks.dueDate), asc(tasks.id))
    .all();
  for (const t of openTasks) {
    const p = out.get(t.containerId!)!;
    if (!p.nextTask) p.nextTask = { id: t.id, title: t.title, dueDate: t.dueDate };
  }
  for (const p of out.values()) {
    p.total = p.open + p.done;
    p.percent = p.total ? Math.round((p.done / p.total) * 100) : 0;
  }
  return out;
}

export function projectProgress(db: DB, containerId: number): Progress {
  return containerProgress(db, [containerId]).get(containerId) ?? emptyProgress();
}
