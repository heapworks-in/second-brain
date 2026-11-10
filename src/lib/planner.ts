import { inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import { items, type Item } from "@/db/schema";
import { addDays, getHelperState, listMeetings, localDay, meetingTimesByItemIds } from "@/domain/activity";
import { listContainers } from "@/domain/containers";
import { suggestContainersFor } from "@/domain/containers/suggest";
import { listPlan, unfinished } from "@/domain/plan";
import { listTasks } from "@/domain/tasks";
import { estimateActualPairs } from "@/domain/focus";
import { getItem, parseMeta } from "@/domain/items";
import { containerMeetings as containerMeetingsByAttribution } from "@/domain/meetings/attribution";
import { driftFactor, forecastMinutes } from "@/lib/drift";
import { serializeMeeting, serializeMeetings, serializePlanTasks, serializeTasks } from "./api";
import { blockedMinutes, freeMinutes, plannedMinutes, unplacedMinutes } from "./capacity";
import { partitionDue } from "./partition";
import { getWorkHours, getWorkingDays, isWorkingDay } from "./work-hours";
import type { ContainerMeetingDTO, MeetingItemDTO, MeetingListDTO, PlannerCalendarDTO, PlannerDayDTO, PlannerSourcesDTO, PlannerWeekDTO, SourceGroupDTO, TaskDTO } from "./dto";

/** What the Planner tells the setup card about the helper's calendar access. */
export function plannerCalendar(db: DB): PlannerCalendarDTO {
  const helper = getHelperState(db);
  return { calendarsSeen: helper.calendarsSeen, permission: helper.permissions?.calendar ?? false };
}

/** How many of a group's tasks are not on the day's plan: the number its heading shows. */
function unplannedIn(tasks: TaskDTO[], plannedIds: Set<number>): number {
  return tasks.reduce((n, t) => n + (plannedIds.has(t.id) ? 0 : 1), 0);
}

/** Open tasks grouped by home: inbox (no container), then every active project and area. A task
 * in an archived container is in no group; it still shows under `due` when it is dated. */
export function plannerSources(db: DB, date: string, plannedIds: Set<number>, window = dayWindow(date)): PlannerSourcesDTO {
  const open = serializeTasks(db, listTasks(db, { status: "open" }), window);
  const unplanned = open.filter((t) => !plannedIds.has(t.id));
  // A group heading needs a name and nothing else, so the rows are turned into refs here rather
  // than through `serializeContainers`, which would count every container's items to say it.
  const groups = (kind: "project" | "area"): SourceGroupDTO[] =>
    listContainers(db, { kind, status: "active" })
      .map((c) => ({ container: { id: c.id, name: c.name, slug: c.slug, kind: c.kind }, tasks: open.filter((t) => t.containerId === c.id) }))
      // Sorted by what the heading counts — the tasks still to plan — so a container whose work
      // is all on the day's plan sinks with the empty ones.
      .sort((a, b) => Number(unplannedIn(b.tasks, plannedIds) > 0) - Number(unplannedIn(a.tasks, plannedIds) > 0));
  return {
    inbox: open.filter((t) => t.containerId === null).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    // Longest wait first, and undated ones among them: for work somebody is waiting on, the wait
    // is the deadline, which is why these are their own group rather than part of `due`.
    owed: unplanned.filter((t) => t.requester !== null).sort((a, b) => (a.askedOn ?? "").localeCompare(b.askedOn ?? "")),
    due: partitionDue(unplanned.filter((t) => t.dueDate !== null && t.dueDate <= date), date),
    projects: groups("project"),
    areas: groups("area"),
  };
}

/**
 * One day of the Planner: the day's plan, what yesterday left open, the day's meetings, the
 * calendar's state, and every open task by where it lives for the picker to draw on. What is
 * due reaches the day through `sources.due`; the day itself lists none of it.
 *
 * `now` defaults to the real clock for every caller that doesn't care, and is threaded to
 * `freeMinutes` rather than read inline, so a test (or a future caller in another timezone) can
 * pin it instead of depending on the machine's own wall clock.
 */
export function plannerDay(db: DB, date: string, now: Date = new Date()): PlannerDayDTO {
  // Every task in the payload carries the day's own sessions and no others: this screen draws
  // one column, and a task's hours on any other day are another day's business.
  const window = dayWindow(date);
  const plan = serializePlanTasks(db, listPlan(db, date), window);
  const plannedIds = new Set(plan.map((t) => t.id));
  const workHours = getWorkHours(db);
  const workingDays = getWorkingDays(db);
  const meetings = plannerMeetings(db, { from: date, to: addDays(date, 1) });
  const { planned, unestimated } = plannedMinutes(plan);
  // One query for the whole request, never one per day — see `plannerWeek`'s own single
  // `driftFactor` call below, hoisted out of its per-day loop the same way.
  const drift = driftFactor(estimateActualPairs(db));
  return {
    date,
    plan,
    unfinishedYesterday: serializeTasks(db, unfinished(db, addDays(date, -1)), window),
    // The same flagged meetings the list view shows, so the timeline can badge them too.
    meetings,
    calendar: plannerCalendar(db),
    sources: plannerSources(db, date, plannedIds, window),
    capacity: {
      freeMinutes: freeMinutes(meetings, workHours, date),
      plannedMinutes: planned,
      unestimated,
      workHours,
      workingDays,
      blockedMinutes: blockedMinutes(plan, date),
      unplacedMinutes: unplacedMinutes(plan, date),
      drift,
      forecastMinutes: forecastMinutes(planned, drift),
      // What is left between now and the end of the working day — distinct from `freeMinutes`
      // above, which is the whole day's window and is what every existing reader of this field
      // still gets.
      leftTodayMinutes: freeMinutes(meetings, workHours, date, { now }),
    },
  };
}

/** The one day a Planner day payload carries sessions for. */
function dayWindow(date: string): { from: string; to: string } {
  return { from: date, to: addDays(date, 1) };
}

/**
 * Seven days from `start`, each with its meetings and the tasks due on it.
 *
 * `now` defaults to the real clock, the same as `plannerDay`, and is threaded to each working
 * day's `leftTodayMinutes` the same way: a day already gone holds nothing, today holds what is
 * left of it, and a day still ahead holds its whole window.
 */
export function plannerWeek(db: DB, start: string, now: Date = new Date()): PlannerWeekDTO {
  const end = addDays(start, 7);
  // The week's own seven days: a column can show nothing outside them.
  const window = { from: start, to: end };
  const byDay = new Map<string, ReturnType<typeof serializeMeeting>[]>();
  // One batched series-decision query for the whole week, not one per event (`serializeMeetings`).
  for (const meeting of serializeMeetings(db, listMeetings(db, { from: start, to: end }))) {
    const day = localDay(meeting.startsAt);
    const list = byDay.get(day);
    if (list) list.push(meeting);
    else byDay.set(day, [meeting]);
  }
  // The week's last day is the latest one a column can hold; anything later is not shown.
  const open = serializeTasks(db, listTasks(db, { status: "open", dueOnOrBefore: addDays(start, 6) }), window);
  const workHours = getWorkHours(db);
  const workingDays = getWorkingDays(db);
  // Drift is one scalar per person per request, never per day: one call here, beside the other
  // once-per-week reads above, and every day below reads the same value rather than each
  // re-measuring it.
  const drift = driftFactor(estimateActualPairs(db));
  return {
    start,
    drift,
    days: Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((date) => {
      const meetings = byDay.get(date) ?? [];
      const working = isWorkingDay(workingDays, date);
      // A Saturday is not nine hours: a non-working day's capacity is reported as zero rather
      // than the whole window it would otherwise claim, and the plan it would need to read to
      // say so truthfully is never even fetched.
      const dayPlan = working ? serializePlanTasks(db, listPlan(db, date), window) : [];
      const planned = working ? plannedMinutes(dayPlan).planned : 0;
      return {
        date,
        working,
        meetings,
        due: open.filter((t) => t.dueDate === date),
        capacity: {
          freeMinutes: working ? freeMinutes(meetings, workHours, date) : 0,
          plannedMinutes: planned,
          blockedMinutes: working ? blockedMinutes(dayPlan, date) : 0,
          forecastMinutes: forecastMinutes(planned, drift),
          // Same figure `plannerDay`'s `leftTodayMinutes` reports, honest about the clock: a
          // day already gone is 0, today is what remains of it, a day ahead is the whole window.
          leftTodayMinutes: working ? freeMinutes(meetings, workHours, date, { now }) : 0,
        },
      };
    }),
  };
}

/** The seed line `captureMeeting` leaves under Actions for the first action to be typed on. */
const EMPTY_ACTION = /^[-*]\s*\[\s*\]\s*$/;
const NOTES_HEADING = /^##\s+Notes\s*$/;
const ACTIONS_HEADING = /^##\s+Actions\s*$/;

/**
 * Whether a meeting note holds anything a person wrote. `captureMeeting` seeds every meeting
 * item with a when/who preamble, an empty Notes heading, and one empty `- [ ]`, so a non-empty
 * body says nothing on its own: only text under Notes, or an action beyond the seed, counts.
 * A body that is not that template at all is judged by whether it has any text.
 */
export function hasUserNotes(body: string): boolean {
  const lines = body.split("\n");
  const notesAt = lines.findIndex((l) => NOTES_HEADING.test(l));
  const actionsAt = lines.findIndex((l) => ACTIONS_HEADING.test(l));
  if (notesAt === -1 && actionsAt === -1) return body.trim().length > 0;
  const notesEnd = actionsAt === -1 ? lines.length : actionsAt;
  if (notesAt !== -1 && lines.slice(notesAt + 1, notesEnd).some((l) => l.trim().length > 0)) return true;
  if (actionsAt === -1) return false;
  return lines.slice(actionsAt + 1).some((l) => l.trim().length > 0 && !EMPTY_ACTION.test(l.trim()));
}

/**
 * The four `MeetingItemDTO` flags an already-fetched item row carries — read here, off the row
 * alone, rather than in `itemFlags` and `containerMeetings` each building their own copy: a
 * future change to what "has notes" means would otherwise have to be made twice, and could
 * silently drift between the Planner and the project page (review F5). Pure: no query of its
 * own, so a caller looping this over a list still costs nothing beyond the rows it already has.
 */
export function meetingItemFlags(row: Item): MeetingItemDTO {
  const meta = parseMeta(row);
  return {
    id: row.id,
    hasNotes: hasUserNotes(row.body),
    hasTranscript: !!meta.transcript,
    hasSummary: !!meta.summary,
    containerId: row.containerId,
  };
}

/** What each linked meeting item already holds, so rows can badge without loading items. */
function itemFlags(db: DB, ids: number[]): Map<number, MeetingItemDTO> {
  const flags = new Map<number, MeetingItemDTO>();
  if (ids.length === 0) return flags;
  for (const row of db.select().from(items).where(inArray(items.id, ids)).all()) {
    flags.set(row.id, meetingItemFlags(row));
  }
  return flags;
}

/**
 * Meetings in `[from, to)`, each carrying its item's badges when it has been captured, and a
 * dull suggestion for where it probably belongs when it has been captured but filed nowhere yet
 * (`suggestContainer`, `@/domain/containers/suggest`) — an offer for the row's chip, never a
 * write of its own. The suggestion pass costs the two queries `suggestContainersFor` batches for
 * its whole list, once for this call, not once per uncontained meeting in it.
 */
export function plannerMeetings(db: DB, opts: { from: string; to: string; q?: string }): MeetingListDTO[] {
  const meetings = serializeMeetings(db, listMeetings(db, opts));
  const flags = itemFlags(
    db,
    meetings.map((m) => m.itemId).filter((id): id is number => id !== null),
  );
  const withItems: MeetingListDTO[] = meetings.map((m) => {
    const item = m.itemId === null ? undefined : flags.get(m.itemId);
    return item ? { ...m, item } : m;
  });

  const uncontained = withItems.filter((m) => m.item && m.item.containerId === null);
  const suggestions = suggestContainersFor(
    db,
    uncontained.map((m) => ({ title: m.title, attendeeNames: m.attendeeNames })),
  );
  const suggestionByMeetingId = new Map(uncontained.map((m, i) => [m.id, suggestions[i] ?? null]));
  return withItems.map((m) => (suggestionByMeetingId.has(m.id) ? { ...m, suggestedContainer: suggestionByMeetingId.get(m.id) } : m));
}

/**
 * Every meeting item filed to a container, for that container's own Meetings section — the
 * same badges `itemFlags` computes for the Planner, plus the meeting's own start time, read here
 * off calendar events rather than the item (which stores none). One query for the calendar
 * times of the whole list, never one per meeting, on top of the item rows the caller already
 * has in hand.
 */
/** Wide enough to mean "this project's whole history", which is what its page should show. */
const ALL_TIME = { from: "0001-01-01", to: "9999-12-31" };

/**
 * A container's meetings, from both ways one can belong to it.
 *
 * Filing the meeting *item* to the container is one way; attributing the calendar event or its
 * whole series is the other, and the page used to see only the first. So a standup assigned to a
 * project showed up in that project's meeting time and nowhere on its page -- and the page's own
 * "see these in the Planner" link led to an empty list for the same reason.
 *
 * Attribution is the primary source, since `effectiveContainerId` already treats a filed item as
 * its third fallback and therefore covers that case too. Filed meeting items with no calendar
 * event behind them -- ad hoc recordings -- have no row to be found that way, so they are added
 * afterwards, keyed by item id so a meeting reachable both ways is listed once.
 */
export function containerMeetings(db: DB, containerId: number, meetingItems: Item[]): ContainerMeetingDTO[] {
  const attributed = containerMeetingsByAttribution(db, containerId, ALL_TIME);
  const itemsById = new Map(meetingItems.map((i) => [i.id, i]));
  const seenItemIds = new Set<number>();

  const rows: ContainerMeetingDTO[] = attributed.map((m) => {
    if (m.itemId !== null) seenItemIds.add(m.itemId);
    const item = m.itemId !== null ? (itemsById.get(m.itemId) ?? getItem(db, m.itemId)) : undefined;
    return {
      title: m.title,
      startsAt: m.startsAt,
      item: item ? meetingItemFlags(item) : null,
      eventId: m.eventId,
    };
  });

  const itemOnly = meetingItems.filter((i) => !seenItemIds.has(i.id));
  const times = meetingTimesByItemIds(
    db,
    itemOnly.map((i) => i.id),
  );
  for (const i of itemOnly) {
    rows.push({ title: i.title, startsAt: times.get(i.id)?.startsAt ?? null, item: meetingItemFlags(i), eventId: null });
  }

  return rows.sort((a, b) => (b.startsAt ?? "").localeCompare(a.startsAt ?? ""));
}
