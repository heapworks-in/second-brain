import { sql } from "drizzle-orm";
import { sqliteTable, integer, text, real, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  ITEM_TYPES,
  ITEM_STATUSES,
  JOB_TYPES,
  JOB_STATUSES,
  CONTAINER_KINDS,
  CONTAINER_STATUSES,
  RESOURCE_CATEGORIES,
  TASK_STATUSES,
  TASK_PRIORITIES,
  MEETING_STATUSES,
  MEETING_DECISIONS,
  CALENDAR_SOURCES,
  GOAL_HORIZONS,
  GOAL_STATUSES,
  FOCUS_OUTCOMES,
  PREDICTION_KINDS,
  PREDICTION_UNITS,
  PROPOSAL_KINDS,
  PROPOSAL_STATES,
} from "./enums";

export { ITEM_TYPES, ITEM_STATUSES, JOB_TYPES, JOB_STATUSES, CONTAINER_KINDS, CONTAINER_STATUSES, RESOURCE_CATEGORIES, TASK_STATUSES, TASK_PRIORITIES, MEETING_STATUSES, MEETING_DECISIONS, CALENDAR_SOURCES, GOAL_HORIZONS, GOAL_STATUSES, FOCUS_OUTCOMES, PREDICTION_KINDS, PREDICTION_UNITS, PROPOSAL_KINDS, PROPOSAL_STATES } from "./enums";
export type { ItemType, ItemStatus, JobType, JobStatus, ContainerKind, ContainerStatus, ResourceCategory, TaskStatus, TaskPriority, MeetingStatus, MeetingDecision, CalendarSource, GoalHorizon, GoalStatus, FocusOutcome, PredictionKind, PredictionUnit, ProposalKind, ProposalState } from "./enums";

export const containers = sqliteTable(
  "containers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: CONTAINER_KINDS }).notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: CONTAINER_STATUSES }).notNull().default("active"),
    goal: text("goal").notNull().default(""),
    deadline: text("deadline"),
    standard: text("standard").notNull().default(""),
    category: text("category", { enum: RESOURCE_CATEGORIES }),
    nextSteps: text("next_steps").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("containers_kind_status_idx").on(t.kind, t.status)],
);

export const items = sqliteTable(
  "items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: ITEM_TYPES }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status", { enum: ITEM_STATUSES }).notNull().default("pending"),
    error: text("error"),
    sourceUrl: text("source_url"),
    filePath: text("file_path"),
    mimeType: text("mime_type"),
    extractedText: text("extracted_text").notNull().default(""),
    meta: text("meta").notNull().default("{}"),
    journalDate: text("journal_date").unique(),
    reviewWeek: text("review_week").unique(),
    containerId: integer("container_id").references(() => containers.id, { onDelete: "set null" }),
    archivedAt: text("archived_at"),
    pinned: integer("pinned").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("items_type_idx").on(t.type),
    index("items_created_idx").on(t.createdAt),
    index("items_container_idx").on(t.containerId),
    index("items_archived_idx").on(t.archivedAt),
  ],
);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
});

export const itemTags = sqliteTable(
  "item_tags",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] })],
);

export const people = sqliteTable("people", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  profile: text("profile").notNull().default(""),
  organization: text("organization").notNull().default(""),
  team: text("team").notNull().default(""),
  title: text("title").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const itemPeople = sqliteTable(
  "item_people",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.personId] })],
);

export const chunks = sqliteTable(
  "chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("chunks_item_idx").on(t.itemId)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: JOB_TYPES }).notNull(),
    payload: text("payload").notNull().default("{}"),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    runAfter: text("run_after").notNull(),
    itemId: integer("item_id").references(() => items.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("jobs_status_run_idx").on(t.status, t.runAfter)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const ACTIVITY_MATCH_KINDS = ["app", "domain", "title_contains"] as const;
export const ACTIVITY_EXCLUSION_KINDS = ["app", "domain"] as const;

export const activityCategories = sqliteTable("activity_categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  color: text("color").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const activityRules = sqliteTable(
  "activity_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchKind: text("match_kind", { enum: ACTIVITY_MATCH_KINDS }).notNull(),
    pattern: text("pattern").notNull(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => activityCategories.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("activity_rules_order_idx").on(t.sortOrder)],
);

export const activityExclusions = sqliteTable(
  "activity_exclusions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ACTIVITY_EXCLUSION_KINDS }).notNull(),
    pattern: text("pattern").notNull(),
  },
  (t) => [uniqueIndex("activity_exclusions_kind_pattern_unique").on(t.kind, t.pattern)],
);

export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    externalId: text("external_id").notNull().unique(),
    title: text("title").notNull(),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at").notNull(),
    attendees: integer("attendees").notNull().default(0),
    hasCallLink: integer("has_call_link").notNull().default(0),
    day: text("day").notNull(),
    organizer: text("organizer").notNull().default(""),
    /** JSON array of attendee display names, capped by the helper. */
    attendeeNames: text("attendee_names").notNull().default("[]"),
    location: text("location").notNull().default(""),
    joinUrl: text("join_url"),
    notes: text("notes").notNull().default(""),
    allDay: integer("all_day").notNull().default(0),
    status: text("status", { enum: MEETING_STATUSES }).notNull().default("none"),
    calendarTitle: text("calendar_title").notNull().default(""),
    /** Who wrote the row: the EventKit helper or a published calendar feed. Each source only purges its own. */
    source: text("source", { enum: CALENDAR_SOURCES }).notNull().default("eventkit"),
    /** The captured meeting item, kept across calendar refreshes. */
    itemId: integer("item_id").references(() => items.id, { onDelete: "set null" }),
    /** Person-set: do not record this meeting. Kept across calendar refreshes. */
    noRecord: integer("no_record").notNull().default(0),
    /** `eventkit:{calendarItemIdentifier}` or `feed:{uid}` — shared by every occurrence of a
     * recurring series, prefixed per source so the two id spaces can never collide. Calendar-owned,
     * refreshed by every sync like `title`. */
    seriesId: text("series_id"),
    /** The person's own call on this occurrence, independent of the calendar's RSVP; null defers
     * to a series decision, then to `status`. Person-owned: excluded from the sync upsert's `set`. */
    decision: text("decision", { enum: MEETING_DECISIONS }),
    /** Free text alongside `decision`, e.g. why. Person-owned, same as `decision`. */
    decisionNote: text("decision_note").notNull().default(""),
    /** Which project or area this one occurrence counts against, when it differs from whatever
     * its series says. Null defers to the series assignment (`meetingSeriesContainers`), then to
     * nothing. Person-owned: excluded from the sync upsert's `set`, like `decision`. */
    containerId: integer("container_id").references(() => containers.id, { onDelete: "set null" }),
  },
  (t) => [index("calendar_events_day_idx").on(t.day), index("calendar_events_container_idx").on(t.containerId)],
);

/**
 * A decision that applies to every occurrence of a recurring meeting, not just one. An
 * occurrence's own `calendarEvents.decision` always wins over this when it is set (see
 * `effectiveDecision`); this is what a "not going, every time" answer writes to instead.
 */
/**
 * Which project or area every occurrence of a recurring meeting counts against. Separate from the
 * occurrence's own `calendarEvents.containerId`, which overrides it, and separate from
 * `meetingSeriesDecisions` because the two answer different questions and behave differently.
 *
 * Deliberately carries no `assignedAt` time scoping, unlike a series *decision*. A decision is
 * forward-only because attendance that already happened cannot retroactively become
 * non-attendance. An assignment is the opposite: saying "this standup belongs to Project X" is a
 * classification of what the meeting has always been, and the entire point of the rollup is to
 * answer "how much has this project cost me" -- which is wrong if it silently excludes every
 * occurrence that happened before someone got around to labelling the series.
 *
 * It also has to live outside `calendarEvents` to survive: a sync deletes rows that fall out of
 * its window (a published feed only carries a short span), so an assignment stored per-row
 * would quietly disappear as meetings age out and come back unattributed.
 */
export const meetingSeriesContainers = sqliteTable("meeting_series_containers", {
  seriesId: text("series_id").primaryKey(),
  containerId: integer("container_id")
    .notNull()
    .references(() => containers.id, { onDelete: "cascade" }),
  assignedAt: text("assigned_at").notNull(),
});
export type MeetingSeriesContainer = typeof meetingSeriesContainers.$inferSelect;

export const meetingSeriesDecisions = sqliteTable("meeting_series_decisions", {
  seriesId: text("series_id").primaryKey(),
  decision: text("decision", { enum: MEETING_DECISIONS }).notNull(),
  note: text("note").notNull().default(""),
  decidedAt: text("decided_at").notNull(),
  /** When this standing call was last confirmed as still right, which is not when it was made:
   * trust is a property of the last check, not of the record. Null until something reaffirms it,
   * and `decidedAt` is the fallback -- a decision never checked is as old as the day it was taken.
   * Read by the desk's `decision_stale` generator; nothing else needs it yet. */
  lastVerified: text("last_verified"),
  /** 0..1, how sure the last check was. Written beside `lastVerified` and never inferred: a
   * confidence the machine made up is worse than none, because it reads as evidence. */
  confidence: real("confidence"),
});
export type MeetingSeriesDecision = typeof meetingSeriesDecisions.$inferSelect;

export const activitySessions = sqliteTable(
  "activity_sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at").notNull(),
    closed: integer("closed").notNull().default(0),
    appId: text("app_id"),
    appName: text("app_name"),
    title: text("title"),
    url: text("url"),
    domain: text("domain"),
    categoryId: integer("category_id").references(() => activityCategories.id, { onDelete: "set null" }),
    afk: integer("afk").notNull().default(0),
    meetingId: integer("meeting_id").references(() => calendarEvents.id, { onDelete: "set null" }),
    heartbeats: integer("heartbeats").notNull().default(1),
    titleChangedAt: text("title_changed_at"),
    /** Set when a person hand-labels the category; recategorise() then leaves the row alone. */
    manual: integer("manual").notNull().default(0),
  },
  (t) => [index("activity_sessions_started_idx").on(t.startedAt), index("activity_sessions_ended_idx").on(t.endedAt)],
);

export type ActivityCategory = typeof activityCategories.$inferSelect;
export type ActivityRule = typeof activityRules.$inferSelect;
export type ActivityExclusion = typeof activityExclusions.$inferSelect;
export type ActivitySession = typeof activitySessions.$inferSelect;
export type CalendarEvent = typeof calendarEvents.$inferSelect;

export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("attachments_item_idx").on(t.itemId)],
);
export type Attachment = typeof attachments.$inferSelect;

/**
 * One imported spreadsheet, and everything the app has to remember in order to give the file
 * back: which columns were which, which status words mean what, and what the header row said.
 *
 * The rows themselves are ordinary tasks -- a tracker is a label on them, not a second place
 * work can live. That is the whole reason `ownerPersonId` exists: a tracker's rows mostly belong
 * to other people, and the alternative to one table with an owner was two tables that disagree.
 */
export const trackers = sqliteTable("trackers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  containerId: integer("container_id").references(() => containers.id, { onDelete: "set null" }),
  /** The file it came from and the sheet inside it, for saying where a row came from. */
  sourceName: text("source_name").notNull().default(""),
  sheetName: text("sheet_name").notNull().default(""),
  /** The header row verbatim, in the file's own order: what an export has to write back. */
  headers: text("headers").notNull().default("[]"),
  /** Which header answers which field, as confirmed in the import preview, plus how Theme was
   * read. Never guessed silently: the preview is where this is agreed. */
  mapping: text("mapping").notNull().default("{}"),
  /** The sheet's own status words, mapped to the three the app reasons with. */
  statusMap: text("status_map").notNull().default("{}"),
  importedAt: text("imported_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export type Tracker = typeof trackers.$inferSelect;

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("open"),
    priority: text("priority", { enum: TASK_PRIORITIES }).notNull().default("normal"),
    dueDate: text("due_date"),
    containerId: integer("container_id").references(() => containers.id, { onDelete: "set null" }),
    sourceItemId: integer("source_item_id").references(() => items.id, { onDelete: "set null" }),
    recurrence: text("recurrence"),
    /** Minutes the task is expected to take; null when nobody has guessed. */
    estimateMinutes: integer("estimate_minutes"),
    /** How long each placed session should be; null means the default sizing (spec §2). */
    sessionMinutes: integer("session_minutes"),
    completedAt: text("completed_at"),
    /**
     * Who asked for this, when somebody did -- the person waiting on it. The direction is never
     * stored: whoever is not the owner is the one waiting, so the two readings of a shared task
     * ("Priya is waiting on me" / "I am waiting on Priya") cannot contradict each other.
     */
    requesterPersonId: integer("requester_person_id").references(() => people.id, { onDelete: "set null" }),
    /** The day they asked, which is not the day it was written down: the wait is measured from
     * the ask. Its own column for the same reason `droppedAt` is one -- `createdAt` moves with
     * the capture, and most of these tasks will never have a due date to fall back on. */
    askedOn: text("asked_on"),
    /**
     * Whose work this is, where that is not mine. Null means mine, which is what makes every
     * surface in the app able to mean "my work" with one predicate rather than a convention
     * every future query has to remember.
     */
    ownerPersonId: integer("owner_person_id").references(() => people.id, { onDelete: "set null" }),
    /** The imported sheet this row came from, when it came from one. */
    trackerId: integer("tracker_id").references(() => trackers.id, { onDelete: "set null" }),
    /** The sheet's grouping column, kept as the text it was: a theme is what the sheet says it
     * is, and matching it by string round-trips exactly. */
    theme: text("theme").notNull().default(""),
    /**
     * The sheet's "Task" cell when this row is a sub-task of it, empty when the row is the task.
     *
     * A label rather than a parent id, because in a real tracker the parent is a repeated (or
     * merged) cell with no row of its own -- and synthesising a task row for it would invent work
     * that belongs to nobody while still landing in my lists. A label also round-trips to the
     * file exactly, which an id cannot.
     */
    parentLabel: text("parent_label").notNull().default(""),
    /** The status word humans read -- "In Progress", "Blocked", "On Hold" -- beside the
     * lifecycle the app reasons with. Written together with `status` so the two cannot drift. */
    statusLabel: text("status_label").notNull().default(""),
    /** Every column of the sheet the mapping did not claim, verbatim, so an export rebuilds the
     * file whole rather than the five columns we understood. */
    sheetExtra: text("sheet_extra").notNull().default("{}"),
    /** Which row of the sheet this was, so an export gives the file back in its own order.
     * Null for a row created here, which exports after the ones that came from the file. */
    sheetRow: integer("sheet_row"),
    /** The instant a drop happened — its own column because `updatedAt` moves on any later
     * edit, and a review of a past week must not have a task migrate into it because someone
     * touched the title months after. */
    droppedAt: text("dropped_at"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("tasks_container_status_order_idx").on(t.containerId, t.status, t.sortOrder),
    index("tasks_status_due_idx").on(t.status, t.dueDate),
    // The tracker page reads one sheet in its own order, and it is the one read here that can
    // be hundreds of rows rather than tens.
    index("tasks_tracker_row_idx").on(t.trackerId, t.sheetRow),
  ],
);
export type Task = typeof tasks.$inferSelect;

/** One session of a task on the timeline. A task holds any number, ordered by start. */
export const taskBlocks = sqliteTable(
  "task_blocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** Local timestamp of the session's start. */
    startsAt: text("starts_at").notNull(),
    minutes: integer("minutes").notNull(),
  },
  (t) => [index("task_blocks_task_idx").on(t.taskId), index("task_blocks_start_idx").on(t.startsAt)],
);
export type TaskBlock = typeof taskBlocks.$inferSelect;

export const dailyPlanEntries = sqliteTable(
  "daily_plan_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("daily_plan_date_task_idx").on(t.date, t.taskId), index("daily_plan_date_idx").on(t.date)],
);
export type DailyPlanEntry = typeof dailyPlanEntries.$inferSelect;

/**
 * An outcome with a date, a level above projects. Progress is never stored here: it is read
 * from the tasks of the containers linked to it, because a hand-typed percentage is the first
 * thing to go stale.
 */
export const goals = sqliteTable(
  "goals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    /** One sentence describing what being finished looks like. */
    outcome: text("outcome").notNull().default(""),
    horizon: text("horizon", { enum: GOAL_HORIZONS }).notNull(),
    targetDate: text("target_date").notNull(),
    status: text("status", { enum: GOAL_STATUSES }).notNull().default("active"),
    notes: text("notes").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    closedAt: text("closed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("goals_status_target_idx").on(t.status, t.targetDate)],
);
export type Goal = typeof goals.$inferSelect;

/** Which projects and areas serve a goal. The link is the whole mechanism of its progress. */
export const goalLinks = sqliteTable(
  "goal_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    goalId: integer("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("goal_links_pair_idx").on(t.goalId, t.containerId), index("goal_links_container_idx").on(t.containerId)],
);
export type GoalLink = typeof goalLinks.$inferSelect;

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Container = typeof containers.$inferSelect;
export type NewContainer = typeof containers.$inferInsert;
export type Person = typeof people.$inferSelect;

/**
 * One stretch of focused work on a task. There is no timer on the server: a live run is a row
 * with no end, and the countdown is arithmetic from its start, so a reload resumes it exactly
 * where it was and a closed browser loses nothing.
 */
export const focusRuns = sqliteTable(
  "focus_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Null for a pomodoro started on nothing in particular -- the timer does not require that
     *  the work already be written down, which is exactly when somebody wants to just start. */
    taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    /** The session this run was started from, when it was started from one. */
    blockId: integer("block_id").references(() => taskBlocks.id, { onDelete: "set null" }),
    startedAt: text("started_at").notNull(),
    /** Null while the run is live. */
    endedAt: text("ended_at"),
    plannedMinutes: integer("planned_minutes").notNull(),
    /** Null while the run is live; zero for an abandoned one. */
    actualMinutes: integer("actual_minutes"),
    outcome: text("outcome", { enum: FOCUS_OUTCOMES }),
  },
  (t) => [
    index("focus_runs_task_idx").on(t.taskId),
    index("focus_runs_started_idx").on(t.startedAt),
    // "One run at a time" as a structural guarantee, not a consequence of Node being
    // single-threaded: every row this index covers (ended_at is null) indexes the same constant
    // expression, so a second one violates uniqueness rather than silently coexisting.
    uniqueIndex("focus_runs_one_live_idx")
      .on(sql`(ended_at is null)`)
      .where(sql`${t.endedAt} is null`),
  ],
);
export type FocusRun = typeof focusRuns.$inferSelect;

/**
 * A call made before the answer is known, and the score it earned once the answer arrived.
 *
 * The one thing a second brain cannot reconstruct after the fact is what you *thought* was going
 * to happen. A task remembers how long it took; nothing remembers the range you gave out loud
 * beforehand, so nobody can tell whether their estimates are any good. This table is that
 * memory, and it is one table rather than three because the move is identical in all three
 * shapes: write it down, put a date on when it resolves, then come back and be honest.
 *
 * The kind-specific numbers are nullable because each kind uses its own, and only its own:
 * `createPrediction` builds the row from the kind rather than from whatever the caller passed,
 * so an estimate can never end up carrying a probability. A row is resolved exactly when
 * `resolvedAt` is set — the open-set query reads that one column rather than guessing from
 * whichever payload column the kind happens to use.
 */
export const predictions = sqliteTable(
  "predictions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: PREDICTION_KINDS }).notNull(),
    /** The claim, specific enough to be checkable later by someone who has forgotten it. */
    claim: text("claim").notNull(),
    /** What it is about, when it is about something already written down. All optional: a call
     *  made in a corridor is still worth logging, and losing its subject must not lose it. */
    containerId: integer("container_id").references(() => containers.id, { onDelete: "set null" }),
    taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
    itemId: integer("item_id").references(() => items.id, { onDelete: "set null" }),
    /** `estimate` only. Two ranges, because one number is a wish: the 50% you think is likely
     *  and the 90% you would be surprised to land outside. `actual` is what it really took. */
    unit: text("unit", { enum: PREDICTION_UNITS }),
    p50Low: real("p50_low"),
    p50High: real("p50_high"),
    p90Low: real("p90_low"),
    p90High: real("p90_high"),
    actual: real("actual"),
    /** `risk` only: 0..1, the stated chance it happens. */
    probability: real("probability"),
    /** `risk` and `call`: 1 if it happened (or the call was right), 0 if not. */
    outcome: integer("outcome"),
    /** The date by which the answer will be known. What makes the log nag rather than rot. */
    resolveBy: text("resolve_by").notNull(),
    resolvedAt: text("resolved_at"),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("predictions_kind_idx").on(t.kind),
    // The two queries that run on every page load: what is overdue to resolve, and the log in
    // reverse order. Both read `resolved_at` first, so it leads the index.
    index("predictions_open_idx").on(t.resolvedAt, t.resolveBy),
    index("predictions_created_idx").on(t.createdAt),
  ],
);
export type Prediction = typeof predictions.$inferSelect;

/**
 * One thing that wants a decision, filled by the desk sweep from data the app already holds.
 *
 * `sourceRef` is a string and deliberately not a relation. A proposal has to outlive the row
 * that caused it: a dismissed `decision_stale` must stay dismissed after the decision is edited,
 * and deleting a task must not cascade away the record that somebody was asked about it. The
 * unique index on `(kind, source_ref)` is what makes the sweep idempotent -- it is how a re-run
 * finds the row it filed last time instead of filing a second one.
 *
 * `payload` carries everything accepting commits, so no commit re-derives anything from a world
 * that has moved on since. A generator that cannot say exactly what accept will do has no
 * business filing a proposal.
 *
 * `rank` is stored rather than computed per read, so the list cannot re-sort itself while
 * somebody is working down it. It moves on the next sweep.
 */
export const proposals = sqliteTable(
  "proposals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: PROPOSAL_KINDS }).notNull(),
    /** Which table the evidence came from: "meeting" | "decision" | "task" | "prediction" | "item". */
    source: text("source").notNull(),
    sourceRef: text("source_ref").notNull(),
    /** The one line that gets read. */
    title: text("title").notNull(),
    /** The evidence, a line or two. Never advice: the buttons are the advice. */
    detail: text("detail").notNull().default(""),
    payload: text("payload").notNull().default("{}"),
    rank: real("rank").notNull().default(0),
    state: text("state", { enum: PROPOSAL_STATES }).notNull().default("open"),
    snoozedUntil: text("snoozed_until"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [
    uniqueIndex("proposals_kind_ref_idx").on(t.kind, t.sourceRef),
    // The page's only query: what is open, best first.
    index("proposals_state_rank_idx").on(t.state, t.rank),
    // `dismissRate` reads the last N decided of one kind, newest first.
    index("proposals_kind_decided_idx").on(t.kind, t.decidedAt),
  ],
);
export type Proposal = typeof proposals.$inferSelect;
