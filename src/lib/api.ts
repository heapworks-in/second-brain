import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "@/db/client";
import { items, type CalendarEvent, type Item, type Container, type Person, type Task, type TaskBlock, type FocusRun, type Prediction } from "@/db/schema";
import { domainOf } from "@/lib/text";
import { getItemTags, parseMeta } from "@/domain/items";
import { CaptureError, DuplicateError } from "@/domain/items/capture";
import { getContainer, countContainerItems, ContainerError } from "@/domain/containers";
import { getItemPeople, peopleByIds, PersonError } from "@/domain/people";
import { ActivityError } from "@/domain/activity/rules";
import { MeetingError } from "@/domain/meetings/errors";
import { effectiveDecisionAsOf, seriesDecisionDetailsFor } from "@/domain/meetings/decision";
import { effectiveContainerId, seriesContainers } from "@/domain/meetings/attribution";
import type { MeetingDecision } from "@/db/enums";
import { AttachmentError } from "@/domain/attachments";
import { projectProgress, containerProgress, TaskError } from "@/domain/tasks";
import { blocksByTask, BlockError } from "@/domain/blocks";
import { GoalError, goalRefsByContainer, goalsWithMeasure, recentCloses, type GoalWithMeasure } from "@/domain/goals";
import { FocusError, focusMinutesByBlock, focusMinutesByTask, likeThisMinutesByTask } from "@/domain/focus";
import { PredictionError } from "@/domain/predictions";
import { DeskError } from "@/domain/desk/decide";
import { addDays, localDay } from "@/domain/activity";
import { isInterview, parseAttendeeNames } from "@/domain/activity/calendar";
import type { Distillation } from "@/domain/distill";
import type { ActivityMeetingDTO, BlockDTO, ItemDTO, ContainerDTO, PersonDTO, PersonRefDTO, TaskDTO, PlanTaskDTO, PinnedLinkDTO, GoalDTO, GoalDetailDTO, GoalRefDTO, FocusRunDTO, PredictionDTO } from "./dto";

export function serializeItem(db: DB, item: Item): ItemDTO {
  const container = item.containerId ? getContainer(db, item.containerId) : undefined;
  const meta = parseMeta<Record<string, unknown> & { distillation?: Distillation }>(item);
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    body: item.body,
    status: item.status,
    error: item.error,
    sourceUrl: item.sourceUrl,
    filePath: item.filePath,
    mimeType: item.mimeType,
    extractedText: item.extractedText,
    meta,
    distillation: meta.distillation,
    tags: getItemTags(db, item.id),
    journalDate: item.journalDate,
    reviewWeek: item.reviewWeek,
    containerId: item.containerId,
    container: container ? { id: container.id, name: container.name, slug: container.slug, kind: container.kind } : null,
    archivedAt: item.archivedAt,
    pinned: item.pinned === 1,
    people: getItemPeople(db, item.id).map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function toPinnedLink(item: Item): PinnedLinkDTO {
  const url = item.sourceUrl ?? "";
  return { id: item.id, title: item.title, url, domain: domainOf(url) };
}

/**
 * The newest three pinned, non-archived link items per container, in one query for all ids
 * instead of one per container. Ordered by createdAt desc, matching the Links section's own
 * pinned-then-newest order (LinksSection's `bySort` in links-section.tsx), so a project's card
 * and its own page agree on which links show.
 */
function pinnedLinksByContainer(db: DB, ids: number[]): Map<number, PinnedLinkDTO[]> {
  const out = new Map<number, PinnedLinkDTO[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const rows = db
    .select()
    .from(items)
    .where(and(inArray(items.containerId, ids), eq(items.type, "link"), eq(items.pinned, 1), isNull(items.archivedAt)))
    .orderBy(desc(items.createdAt), desc(items.id))
    .all();
  for (const row of rows) {
    const list = out.get(row.containerId!);
    if (list && list.length < 3) list.push(toPinnedLink(row));
  }
  return out;
}

export function serializeContainer(db: DB, c: Container): ContainerDTO {
  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    slug: c.slug,
    description: c.description,
    status: c.status,
    goal: c.goal,
    deadline: c.deadline,
    standard: c.standard,
    nextSteps: c.nextSteps,
    category: c.category,
    sortOrder: c.sortOrder,
    archivedAt: c.archivedAt,
    itemCount: countContainerItems(db, c.id),
    totalItemCount: countContainerItems(db, c.id, true),
    progress: projectProgress(db, c.id),
    pinnedLinks: pinnedLinksByContainer(db, [c.id]).get(c.id)!,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Serializes many containers with progress and pinned links computed in grouped queries instead of one per row. */
export function serializeContainers(db: DB, list: Container[]): ContainerDTO[] {
  const ids = list.map((c) => c.id);
  const progress = containerProgress(db, ids);
  const pinnedLinks = pinnedLinksByContainer(db, ids);
  return list.map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
    slug: c.slug,
    description: c.description,
    status: c.status,
    goal: c.goal,
    deadline: c.deadline,
    standard: c.standard,
    nextSteps: c.nextSteps,
    category: c.category,
    sortOrder: c.sortOrder,
    archivedAt: c.archivedAt,
    itemCount: countContainerItems(db, c.id),
    totalItemCount: countContainerItems(db, c.id, true),
    progress: progress.get(c.id)!,
    pinnedLinks: pinnedLinks.get(c.id)!,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
}

/** A session row, optionally carrying what has actually been run against it. The minutes ride on
 * the row rather than arriving as a parameter of their own: `serializeTask` already takes five,
 * and every caller that has the figure already has the rows to hang it on. */
export type BlockRow = TaskBlock & { spentMinutes?: number };

export function serializeBlock(b: BlockRow): BlockDTO {
  return { id: b.id, taskId: b.taskId, startsAt: b.startsAt, minutes: b.minutes, spentMinutes: b.spentMinutes ?? 0 };
}

/** Every listed task's sessions in the window, each carrying the minutes run against it: one
 * query for the sessions and one for the runs, whatever the length of the list. */
function blocksWithSpent(db: DB, taskIds: number[], window: { from: string; to: string }): Map<number, BlockRow[]> {
  const byTask = blocksByTask(db, taskIds, window);
  const spent = focusMinutesByBlock(db, [...byTask.values()].flat().map((b) => b.id));
  const out = new Map<number, BlockRow[]>();
  for (const [taskId, blocks] of byTask) out.set(taskId, blocks.map((b) => ({ ...b, spentMinutes: spent.get(b.id) ?? 0 })));
  return out;
}

/** A task, its sessions, the active goals its container serves, what it has cost so far, and
 * what finished work like it cost. All four are passed in rather than read here, so a list pays
 * for one query each instead of one per row. */
export function serializeTask(
  t: Task,
  blocks: BlockRow[] = [],
  goals: GoalRefDTO[] = [],
  spentMinutes = 0,
  likeThisMinutes: number | null = null,
  requester: PersonRefDTO | null = null,
): TaskDTO {
  return {
    id: t.id,
    title: t.title,
    notes: t.notes,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    containerId: t.containerId,
    sourceItemId: t.sourceItemId,
    requester,
    askedOn: t.askedOn,
    estimateMinutes: t.estimateMinutes,
    sessionMinutes: t.sessionMinutes,
    blocks: blocks.map(serializeBlock),
    goals,
    spentMinutes,
    likeThisMinutes,
    completedAt: t.completedAt,
    sortOrder: t.sortOrder,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** The plan entry's order wins over the task's own: on a plan, position means the day's order. */
export function serializePlanTask(
  t: Task & { planId: number; sortOrder: number },
  blocks: BlockRow[] = [],
  goals: GoalRefDTO[] = [],
  spentMinutes = 0,
  likeThisMinutes: number | null = null,
  requester: PersonRefDTO | null = null,
): PlanTaskDTO {
  return { ...serializeTask(t, blocks, goals, spentMinutes, likeThisMinutes, requester), sortOrder: t.sortOrder, planId: t.planId };
}

/** How many days either side of today a task list carries sessions for: last week, because a
 * session missed is still worth saying, and two months ahead, which is further than any screen
 * plans. Past that a payload would grow with a task's whole history for nothing. */
const WINDOW_BEFORE = 7;
const WINDOW_AFTER = 60;

/** The window a list of tasks carries its sessions in; `to` is exclusive, both are dates. */
export function taskBlockWindow(today: string = localDay(new Date().toISOString())): { from: string; to: string } {
  return { from: addDays(today, -WINDOW_BEFORE), to: addDays(today, WINDOW_AFTER) };
}

/** Every listed task's container's active goals, in one query for the distinct container ids
 * rather than one per task: the same shape `blocksByTask` already reads for sessions. */
function goalsByTask(db: DB, list: { id: number; containerId: number | null }[]): Map<number, GoalRefDTO[]> {
  const containerIds = [...new Set(list.map((t) => t.containerId).filter((id): id is number => id !== null))];
  const byContainer = goalRefsByContainer(db, containerIds);
  const out = new Map<number, GoalRefDTO[]>();
  for (const t of list) out.set(t.id, (t.containerId !== null ? byContainer.get(t.containerId) : undefined) ?? []);
  return out;
}

/** A list of tasks with their sessions, goals, spent minutes and like-this minutes, in one query
 * each for the lot — never one per row. The window bounds what each row carries: without one a
 * task placed every day for a year would serialize all of it. */
/** Every listed task's requester in one query, as a ref -- a task points at one person, so this
 * is a lookup by id rather than the item/people join `serializeItem` walks. */
function requestersByTask(db: DB, list: Task[]): Map<number, PersonRefDTO> {
  const named = list.filter((t) => t.requesterPersonId !== null);
  if (named.length === 0) return new Map();
  const byId = peopleByIds(db, named.map((t) => t.requesterPersonId!));
  const out = new Map<number, PersonRefDTO>();
  for (const t of named) {
    const p = byId.get(t.requesterPersonId!);
    if (p) out.set(t.id, { id: p.id, name: p.name, slug: p.slug });
  }
  return out;
}

/** One task's requester, for the single-row routes. A list uses `requestersByTask` instead. */
export function requesterRef(db: DB, t: Task): PersonRefDTO | null {
  return requestersByTask(db, [t]).get(t.id) ?? null;
}

export function serializeTasks(db: DB, list: Task[], window: { from: string; to: string } = taskBlockWindow()): TaskDTO[] {
  const byTask = blocksWithSpent(db, list.map((t) => t.id), window);
  const goals = goalsByTask(db, list);
  const spent = focusMinutesByTask(db, list.map((t) => t.id));
  const likeThis = likeThisMinutesByTask(db, list);
  const requesters = requestersByTask(db, list);
  return list.map((t) => serializeTask(t, byTask.get(t.id) ?? [], goals.get(t.id) ?? [], spent.get(t.id) ?? 0, likeThis.get(t.id) ?? null, requesters.get(t.id) ?? null));
}

/** A day's plan with its sessions, goals, spent minutes and like-this minutes, in one query
 * each for the lot. */
export function serializePlanTasks(
  db: DB,
  list: (Task & { planId: number; sortOrder: number })[],
  window: { from: string; to: string } = taskBlockWindow(),
): PlanTaskDTO[] {
  const byTask = blocksWithSpent(db, list.map((t) => t.id), window);
  const goals = goalsByTask(db, list);
  const spent = focusMinutesByTask(db, list.map((t) => t.id));
  const likeThis = likeThisMinutesByTask(db, list);
  const requesters = requestersByTask(db, list);
  return list.map((t) => serializePlanTask(t, byTask.get(t.id) ?? [], goals.get(t.id) ?? [], spent.get(t.id) ?? 0, likeThis.get(t.id) ?? null, requesters.get(t.id) ?? null));
}

/**
 * A calendar row as the Planner reads it. `actualMs` is 0: measuring how long a meeting was
 * actually attended means walking that day's sessions, which `getDay` does for the Activity
 * page; the Planner shows scheduled time and never asks for the measured figure.
 *
 * `seriesDecision` is the resolved answer for `ev.seriesId` (or null for a one-off meeting, or
 * when nobody has decided one) — the caller's to supply, from a single batched
 * `seriesDecisionDetailsFor` call over a whole list, never one query per row (see
 * `serializeMeetings` below for the list case, and `serializeMeetingResolved` for a lone row).
 * It carries `decidedAt` alongside the decision because the effective answer here is resolved
 * with `effectiveDecisionAsOf`, not plain `effectiveDecision`: every list this serializer feeds
 * reaches into the past (the Meetings view's window runs thirty days back, and all the way back
 * when filtered by container), and a series declined today must not re-render an hour the person
 * genuinely sat through last month as "Not going" — which is exactly what the meeting audit,
 * reading the same rows through `effectiveDecisionAsOf`, would then contradict. For anything from
 * now onward the two resolutions agree, so nothing about a day still ahead changes.
 */
export function serializeMeeting(
  ev: CalendarEvent,
  seriesDecision: { decision: MeetingDecision; decidedAt: string } | null = null,
  seriesContainerId: number | null = null,
): ActivityMeetingDTO {
  return {
    id: ev.id,
    title: ev.title,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    attendees: ev.attendees,
    hasCallLink: ev.hasCallLink === 1,
    interview: isInterview(ev.title),
    scheduledMs: Date.parse(ev.endsAt) - Date.parse(ev.startsAt),
    actualMs: 0,
    itemId: ev.itemId,
    organizer: ev.organizer,
    attendeeNames: parseAttendeeNames(ev.attendeeNames),
    location: ev.location,
    joinUrl: ev.joinUrl,
    allDay: ev.allDay === 1,
    status: ev.status,
    calendarTitle: ev.calendarTitle,
    noRecord: ev.noRecord === 1,
    seriesId: ev.seriesId,
    decision: effectiveDecisionAsOf(ev, seriesDecision),
    decisionNote: ev.decisionNote,
    seriesDecision: seriesDecision?.decision ?? null,
    containerId: effectiveContainerId(ev, seriesContainerId),
    containerFromSeries: ev.containerId === null && seriesContainerId !== null,
  };
}

/** Every listed event's series decision resolved in one query, not one per row — the same
 * batching rule `focusMinutesByTask` and `goalRefsByContainer` already follow for their lists. */
export function serializeMeetings(db: DB, events: CalendarEvent[]): ActivityMeetingDTO[] {
  const seriesIds = [...new Set(events.map((e) => e.seriesId).filter((id): id is string => id !== null))];
  const decisions = seriesDecisionDetailsFor(db, seriesIds);
  const containers = seriesContainers(db, seriesIds);
  return events.map((ev) =>
    serializeMeeting(
      ev,
      ev.seriesId ? (decisions.get(ev.seriesId) ?? null) : null,
      ev.seriesId ? (containers.get(ev.seriesId) ?? null) : null,
    ),
  );
}

/** A single row's own series decision, resolved with its own one-row query — never called from
 * a loop over a list, which is what `serializeMeetings` above is for. */
export function serializeMeetingResolved(db: DB, ev: CalendarEvent): ActivityMeetingDTO {
  const seriesDecision = ev.seriesId ? (seriesDecisionDetailsFor(db, [ev.seriesId]).get(ev.seriesId) ?? null) : null;
  const seriesContainerId = ev.seriesId ? (seriesContainers(db, [ev.seriesId]).get(ev.seriesId) ?? null) : null;
  return serializeMeeting(ev, seriesDecision, seriesContainerId);
}

export function serializeGoal(g: GoalWithMeasure): GoalDTO {
  return {
    id: g.id,
    title: g.title,
    outcome: g.outcome,
    horizon: g.horizon,
    targetDate: g.targetDate,
    status: g.status,
    notes: g.notes,
    sortOrder: g.sortOrder,
    closedAt: g.closedAt,
    measure: g.measure,
    containers: g.containers,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/** How many of a goal's most recently closed tasks its detail page carries. */
const RECENT_CLOSES = 10;

/**
 * The goal detail payload, built once here rather than separately by the server-rendered page
 * and its API route — the two are the same three calls in the same order, and having only one
 * of them means there is nothing left to drift out of sync. Undefined when the goal does not
 * exist, so each caller keeps its own choice of 404.
 */
export function goalDetail(db: DB, id: number, today: string): GoalDetailDTO | undefined {
  const [goal] = goalsWithMeasure(db, { id }, today);
  if (!goal) return undefined;
  const progress = containerProgress(db, goal.containers.map((c) => c.id));
  return {
    ...serializeGoal(goal),
    links: goal.containers.map((container) => ({ container, progress: progress.get(container.id)! })),
    recentCloses: recentCloses(db, id, RECENT_CLOSES),
  };
}

/** `taskTitle` is passed in rather than read here, the same as `serializeTask`'s blocks and
 * goals: the task is already in hand at every call site, so this reads no second row. */
export function serializeFocusRun(run: FocusRun, taskTitle: string): FocusRunDTO {
  return {
    id: run.id,
    taskId: run.taskId,
    taskTitle,
    blockId: run.blockId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    plannedMinutes: run.plannedMinutes,
    actualMinutes: run.actualMinutes,
    outcome: run.outcome,
  };
}

/**
 * A logged call, as every surface reads it. The kind decides which numbers are present, so they
 * are carried through as they are stored — null where the kind does not use them — rather than
 * flattened into one "value" field that the client would then have to un-flatten by kind anyway.
 */
export function serializePrediction(p: Prediction): PredictionDTO {
  return {
    id: p.id,
    kind: p.kind,
    claim: p.claim,
    containerId: p.containerId,
    taskId: p.taskId,
    itemId: p.itemId,
    unit: p.unit,
    p50Low: p.p50Low,
    p50High: p.p50High,
    p90Low: p.p90Low,
    p90High: p.p90High,
    actual: p.actual,
    probability: p.probability,
    outcome: p.outcome,
    resolveBy: p.resolveBy,
    resolvedAt: p.resolvedAt,
    notes: p.notes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export function serializePerson(p: Person & { itemCount?: number; lastContact?: string | null; meetingCount?: number }, itemCount?: number): PersonDTO {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    profile: p.profile,
    organization: p.organization,
    team: p.team,
    title: p.title,
    itemCount: itemCount ?? p.itemCount ?? 0,
    lastContact: p.lastContact ?? null,
    meetingCount: p.meetingCount ?? 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * Whether the request came from a page that is not this app. Routes that run a local command
 * or drive the recording helper gate on it, so a page on any other site cannot reach them
 * through the browser: a POST with no body takes no preflight, so a cross-origin `no-cors`
 * fetch or form post would otherwise land. A request with no `Origin` header is not a
 * cross-site form post and is let through.
 */
export function crossSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const { port } = new URL(req.url);
  const suffix = port ? `:${port}` : "";
  return origin !== `http://127.0.0.1${suffix}` && origin !== `http://localhost${suffix}`;
}

/** The one answer every origin-gated route gives, so they are indistinguishable from outside. */
export function forbidden(): NextResponse {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof DuplicateError) {
    return NextResponse.json({ error: err.message, existingId: err.existingId }, { status: err.status });
  }
  // A body that fails schema validation is a client mistake, not a server one: it reads as 400
  // here so a route that parses straight through zod never needs its own catch for it.
  if (err instanceof ZodError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (
    err instanceof CaptureError ||
    err instanceof ContainerError ||
    err instanceof PersonError ||
    err instanceof ActivityError ||
    err instanceof MeetingError ||
    err instanceof AttachmentError ||
    err instanceof TaskError ||
    err instanceof BlockError ||
    err instanceof GoalError ||
    err instanceof FocusError ||
    err instanceof PredictionError ||
    err instanceof DeskError
  ) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api]", message);
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Parse a positive integer route param. Throws CaptureError(400) otherwise. */
export function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new CaptureError(`Invalid id: ${raw}`, 400);
  return id;
}

/** `container=<id>` → id, `container=inbox` → null, absent → undefined. Throws CaptureError(400) on garbage. */
export function parseContainerParam(raw: string | null): number | null | undefined {
  if (raw === null || raw === "") return undefined;
  if (raw === "inbox") return null;
  return parseId(raw);
}
