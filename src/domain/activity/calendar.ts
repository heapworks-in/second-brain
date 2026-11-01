import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { activitySessions, calendarEvents, items, type CalendarEvent, type CalendarSource, type Item, type MeetingStatus } from "@/db/schema";
import { createItem } from "@/domain/items";
import { ActivityError, listCategories } from "./rules";
import { localDay } from "@/lib/time";

export interface CalendarEventInput {
  externalId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  attendees: number;
  hasCallLink: boolean;
  organizer?: string;
  attendeeNames?: string[];
  location?: string;
  joinUrl?: string | null;
  notes?: string;
  allDay?: boolean;
  status?: MeetingStatus;
  calendarTitle?: string;
  /** `eventkit:{calendarItemIdentifier}` or `feed:{uid}` — the same value across every occurrence
   * of a recurring series, and a harmless "series of one" for a non-recurring event. Prefixed per
   * source so the two unrelated id spaces can never collide once something groups by this value
   * across sources. Persisted by `replaceCalendarEvents` below, refreshed every sync like `title`. */
  seriesId?: string;
}

/** The providers whose links mean "this is a video call", matching the EventKit helper's own list
 * (helper/activity/Sources/sb-activity/CalendarReader.swift) so the three sync paths agree. */
const PROVIDER_RE = /https?:\/\/[^\s<>"')]*(?:teams\.microsoft\.com|zoom\.us|meet\.google\.com|webex\.com)[^\s<>"')]*/i;
const ANY_RE = /https?:\/\/[^\s<>"')]+/i;

/**
 * The call link, or null — a recognised provider only.
 *
 * Deliberately separate from `joinUrlFrom`: "is this a video call?" and "is there anything to
 * open?" are different questions, and answering the first with the second is what made
 * auto-recording fire on everything. A work invite nearly always carries *some* link — an agenda
 * page, a Jira ticket, a doc, a map pin — so the any-url fallback below marked a desk
 * conversation as a call and the rule recorded it. Only this function decides `hasCallLink`, and
 * so whether a meeting records itself.
 */
export function callLinkFrom(...texts: (string | null | undefined)[]): string | null {
  return texts.filter(Boolean).join(" ").match(PROVIDER_RE)?.[0] ?? null;
}

/**
 * Where to send someone who wants to join: the call link, else the first url in the texts.
 *
 * The fallback stays, because a "Join" button pointing at the only link in an invite is better
 * than no button. It just no longer implies a call — see `callLinkFrom`.
 */
export function joinUrlFrom(...texts: (string | null | undefined)[]): string | null {
  const joined = texts.filter(Boolean).join(" ");
  return callLinkFrom(joined) ?? joined.match(ANY_RE)?.[0] ?? null;
}

/** Local calendar day (YYYY-MM-DD) of an ISO timestamp. Defined in `@/lib/time` so the
 * client components that label the same instants can share one implementation; re-exported
 * here because the whole app already reads it off the activity barrel. */
export { localDay };

/** Local midnight to next local midnight, as UTC ISO strings. */
export function dayBounds(day: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ActivityError("Day must be YYYY-MM-DD");
  const [y, m, d] = day.split("-").map(Number);
  return { start: new Date(y, m - 1, d).toISOString(), end: new Date(y, m - 1, d + 1).toISOString() };
}

export function isInterview(title: string): boolean {
  return /interview/i.test(title);
}

/** The local-day range a calendar payload speaks for: `[from, to)`. */
export interface CalendarWindow {
  from: string;
  to: string;
}

/**
 * Upserts the payload by `externalId` and drops the events that vanished from the window.
 * Rows keep their `id` (sessions reference it), `item_id`, and `no_record`; a payload without a
 * window speaks only for the days it carries, which is what older helpers mean by a post.
 *
 * A window is only believed when the payload proves the helper could read the calendar: it
 * carries events, or it reports how many calendars it saw. An empty payload from a helper
 * that was refused calendar access must not purge two months of meetings.
 */
export function replaceCalendarEvents(
  db: DB,
  events: CalendarEventInput[],
  window?: CalendarWindow,
  proof: { calendarsSeen?: number } = {},
  /** Rows from another source are never this call's to remove. */
  opts: { source?: CalendarSource } = {},
): { days: string[]; inserted: number; removed: number } {
  const source: CalendarSource = opts.source ?? "eventkit";
  const days = [...new Set(events.map((e) => localDay(e.startsAt)))];
  const externalIds = events.map((e) => e.externalId);
  let inserted = 0;
  let removed = 0;
  db.transaction((tx) => {
    for (const e of events) {
      if (Date.parse(e.endsAt) <= Date.parse(e.startsAt)) continue;
      const joinUrl = e.joinUrl ?? joinUrlFrom(e.location, e.notes);
      // Asked of the texts, never of `joinUrl`, which may be any old link (see `joinUrlFrom`).
      // `e.hasCallLink` is the EventKit helper's own strict answer and is trusted as it stands;
      // reading it off `joinUrl` instead is what used to widen it straight back to "any url".
      const isCall = e.hasCallLink || callLinkFrom(e.location, e.notes) !== null;
      // item_id, no_record, decision and decision_note are ours, not the calendar's: they stay
      // off the upsert so a refresh keeps them. e.seriesId is calendar-owned like title, so it
      // belongs inside the upsert and is refreshed every sync.
      const values = {
        externalId: e.externalId,
        title: e.title.trim() || "Untitled event",
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        attendees: e.attendees,
        hasCallLink: isCall ? 1 : 0,
        day: localDay(e.startsAt),
        organizer: e.organizer ?? "",
        attendeeNames: JSON.stringify(e.attendeeNames ?? []),
        location: e.location ?? "",
        joinUrl,
        notes: e.notes ?? "",
        allDay: e.allDay ? 1 : 0,
        status: e.status ?? "none",
        calendarTitle: e.calendarTitle ?? "",
        seriesId: e.seriesId ?? null,
        source,
      };
      tx.insert(calendarEvents).values(values).onConflictDoUpdate({ target: calendarEvents.externalId, set: values }).run();
      inserted++;
    }
    const hasAccess = events.length > 0 || proof.calendarsSeen !== undefined;
    const inWindow =
      window && hasAccess
        ? and(gte(calendarEvents.day, window.from), lt(calendarEvents.day, window.to))
        : days.length
          ? inArray(calendarEvents.day, days)
          : undefined;
    if (inWindow) {
      const mine = and(inWindow, eq(calendarEvents.source, source));
      const stale = externalIds.length ? and(mine, notInArray(calendarEvents.externalId, externalIds)) : mine;
      removed = tx.delete(calendarEvents).where(stale).run().changes;
    }
  });
  labelMeetings(db, days);
  return { days, inserted, removed };
}

/** The stored attendee-name JSON as a list of names; tolerant of anything else. */
export function parseAttendeeNames(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Per captured meeting item id, the calendar event it was captured from — start and end time in
 * particular, since neither lives on the item itself. One query for the whole list of item ids,
 * never one per item, the same shape every other list-cost finding in this repository has
 * already flagged.
 */
export function meetingTimesByItemIds(db: DB, itemIds: number[]): Map<number, { startsAt: string; endsAt: string }> {
  const out = new Map<number, { startsAt: string; endsAt: string }>();
  if (itemIds.length === 0) return out;
  const rows = db
    .select({ itemId: calendarEvents.itemId, startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt })
    .from(calendarEvents)
    .where(inArray(calendarEvents.itemId, itemIds))
    .all();
  for (const row of rows) {
    if (row.itemId !== null) out.set(row.itemId, { startsAt: row.startsAt, endsAt: row.endsAt });
  }
  return out;
}

/** Events starting on a day in [from, to), oldest first; `q` matches title, organizer, or an attendee name. */
export function listMeetings(db: DB, opts: { from: string; to: string; q?: string }): CalendarEvent[] {
  const rows = db
    .select()
    .from(calendarEvents)
    .where(and(gte(calendarEvents.day, opts.from), lt(calendarEvents.day, opts.to)))
    .orderBy(asc(calendarEvents.startsAt))
    .all();
  const q = opts.q?.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((e) => [e.title, e.organizer, e.attendeeNames].join(" ").toLowerCase().includes(q));
}

/** The person's "do not record this one" flag. Kept across calendar refreshes by the upsert. */
export function setMeetingNoRecord(db: DB, id: number, noRecord: boolean): CalendarEvent {
  const updated = db
    .update(calendarEvents)
    .set({ noRecord: noRecord ? 1 : 0 })
    .where(eq(calendarEvents.id, id))
    .returning()
    .get();
  if (!updated) throw new ActivityError("Meeting not found", 404);
  return updated;
}

export function findMeetingFor(db: DB, at: string): CalendarEvent | undefined {
  return db
    .select()
    .from(calendarEvents)
    .where(and(lte(calendarEvents.startsAt, at), gt(calendarEvents.endsAt, at)))
    .orderBy(desc(calendarEvents.hasCallLink), asc(calendarEvents.startsAt))
    .get();
}

/** Attach events to unlabelled Meetings-category sessions on the given days. Returns rows changed. */
export function labelMeetings(db: DB, days: string[]): number {
  const meetings = listCategories(db).find((c) => c.name === "Meetings");
  if (!meetings || days.length === 0) return 0;
  let changed = 0;
  for (const day of days) {
    const { start, end } = dayBounds(day);
    const rows = db
      .select()
      .from(activitySessions)
      .where(
        and(
          eq(activitySessions.categoryId, meetings.id),
          isNull(activitySessions.meetingId),
          lt(activitySessions.startedAt, end),
          gt(activitySessions.endedAt, start),
        ),
      )
      .all();
    for (const s of rows) {
      const ev = findMeetingFor(db, s.startedAt) ?? findMeetingFor(db, s.endedAt);
      if (ev) {
        db.update(activitySessions).set({ meetingId: ev.id }).where(eq(activitySessions.id, s.id)).run();
        changed++;
      }
    }
  }
  return changed;
}

export function findCapturedMeetingItem(db: DB, eventId: number): Item | undefined {
  const ev = db.select({ itemId: calendarEvents.itemId }).from(calendarEvents).where(eq(calendarEvents.id, eventId)).get();
  if (ev?.itemId) {
    const linked = db.select().from(items).where(eq(items.id, ev.itemId)).get();
    if (linked) return linked;
  }
  return db
    .select()
    .from(items)
    .where(sql`json_extract(${items.meta}, '$.calendarEventId') = ${eventId}`)
    .get();
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function captureMeeting(db: DB, eventId: number): Item {
  const ev = db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId)).get();
  if (!ev) throw new ActivityError("Meeting not found", 404);
  const existing = findCapturedMeetingItem(db, eventId);
  if (existing) {
    if (ev.itemId !== existing.id) db.update(calendarEvents).set({ itemId: existing.id }).where(eq(calendarEvents.id, ev.id)).run();
    return existing;
  }
  const body = [
    `**When:** ${localDay(ev.startsAt)} ${fmtTime(ev.startsAt)} to ${fmtTime(ev.endsAt)}`,
    `**Who:** ${ev.attendees} attendees`,
    "",
    "## Notes",
    "",
    "## Actions",
    "",
    "- [ ] ",
  ].join("\n");
  const item = createItem(db, {
    type: "meeting",
    title: ev.title,
    body,
    status: "ready",
    meta: { calendarEventId: ev.id, interview: isInterview(ev.title) },
  });
  db.update(calendarEvents).set({ itemId: item.id }).where(eq(calendarEvents.id, ev.id)).run();
  return item;
}
