import ICAL from "ical.js";
import type { DB } from "@/db/client";
import type { MeetingStatus } from "@/db/schema";
import { eq } from "drizzle-orm";
import { calendarEvents, settings } from "@/db/schema";
import { getSetting, setSetting } from "@/domain/settings";
import { addDays } from "./report";
import { callLinkFrom, joinUrlFrom, localDay, replaceCalendarEvents, type CalendarEventInput } from "./calendar";

/** The settings a published calendar feed lives in. */
export const FEED_URL_KEY = "calendar.feedUrl";
const SYNCED_AT_KEY = "calendar.feedSyncedAt";
const ERROR_KEY = "calendar.feedError";
const COUNT_KEY = "calendar.feedCount";

/** The window the helper also fills: thirty days back, sixty ahead. */
const PAST_DAYS = 30;
const AHEAD_DAYS = 60;
/** Feeds are small; a link that takes longer than this is not answering. */
const FETCH_TIMEOUT_MS = 20_000;
/** Steps a rule may be walked from its first date to the window; a daily meeting from 2018 needs a few thousand. */
const MAX_STEPS = 200_000;
/** Occurrences kept per feed: past this the calendar is not one a person reads. */
const MAX_OCCURRENCES = 5000;
/** Calendar bodies are capped the way the helper caps them. */
const NOTES_CAP = 4000;

export interface FeedState {
  feedUrl: string;
  syncedAt: string | null;
  error: string | null;
  count: number;
}

export interface FeedWindow {
  from: Date;
  to: Date;
}

export function getFeedState(db: DB): FeedState {
  return {
    feedUrl: getSetting(db, FEED_URL_KEY, ""),
    syncedAt: getSetting(db, SYNCED_AT_KEY, "") || null,
    error: getSetting(db, ERROR_KEY, "") || null,
    count: Number(getSetting(db, COUNT_KEY, "0")) || 0,
  };
}

/** `webcal://` is what Outlook hands out; it is https with a different scheme. */
export function normalizeFeedUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const url = new URL(trimmed.replace(/^webcal:\/\//i, "https://"));
  if (url.protocol !== "https:") throw new Error("The link must start with https:// or webcal://");
  return url.toString();
}

/** A new link, or none, starts from nothing: the old feed's meetings go with it. */
export function setFeedUrl(db: DB, raw: string): FeedState {
  const url = normalizeFeedUrl(raw);
  const previous = getSetting(db, FEED_URL_KEY, "");
  db.transaction((tx) => {
    if (url !== previous) tx.delete(calendarEvents).where(eq(calendarEvents.source, "feed")).run();
    for (const [key, value] of [[FEED_URL_KEY, url], [ERROR_KEY, ""], [SYNCED_AT_KEY, ""], [COUNT_KEY, "0"]] as const) {
      tx.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
    }
  });
  return getFeedState(db);
}

function text(comp: ICAL.Component, name: string): string {
  const v = comp.getFirstPropertyValue(name);
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function personName(prop: ICAL.Property | null): string {
  if (!prop) return "";
  const cn = prop.getParameter("cn");
  if (typeof cn === "string" && cn.trim()) return cn.trim();
  const v = prop.getFirstValue();
  return typeof v === "string" ? v.replace(/^mailto:/i, "") : "";
}

/** Outlook marks its own tentative acceptances on the busy status; anything busy is a meeting kept. */
function statusOf(comp: ICAL.Component): MeetingStatus {
  const busy = text(comp, "x-microsoft-cdo-busystatus").toUpperCase();
  if (busy === "TENTATIVE") return "tentative";
  if (busy === "BUSY" || busy === "OOF") return "accepted";
  return "none";
}

/**
 * A timed value whose TZID the feed never defined is floating, which ical.js would read as
 * the server's wall clock; UTC is the honest reading. All-day values stay floating on purpose:
 * that is what puts them on their own local day.
 */
function asInstant(t: ICAL.Time): ICAL.Time {
  if (!t.isDate && t.zone === ICAL.Timezone.localTimezone) {
    const u = t.clone();
    u.zone = ICAL.Timezone.utcTimezone;
    return u;
  }
  return t;
}

function occurrenceInput(ev: ICAL.Event, start: ICAL.Time, end: ICAL.Time, externalId: string, calendarTitle: string): CalendarEventInput {
  const comp = ev.component;
  const description = ev.description ?? "";
  const location = ev.location ?? "";
  const attendees = ev.attendees.map((p) => personName(p)).filter(Boolean);
  const teams = text(comp, "x-microsoft-skypeteamsmeetingurl") || text(comp, "x-microsoft-onlinemeetingexternallink");
  const joinUrl = joinUrlFrom(teams, location, description);
  // `x-microsoft-skypeteamsmeetingurl` is a call link by definition, whatever host it names.
  const isCall = !!teams || callLinkFrom(location, description) !== null;
  return {
    externalId,
    title: ev.summary ?? "",
    startsAt: asInstant(start).toJSDate().toISOString(),
    endsAt: asInstant(end).toJSDate().toISOString(),
    attendees: attendees.length,
    hasCallLink: isCall,
    organizer: personName(comp.getFirstProperty("organizer")),
    attendeeNames: attendees,
    location,
    joinUrl,
    notes: description.slice(0, NOTES_CAP),
    allDay: start.isDate,
    status: statusOf(comp),
    calendarTitle,
    // externalId already embeds ev.uid (as `feed:{uid}` or `feed:{uid}:{recurrenceId}`) to keep
    // occurrences distinct rows; seriesId is the same uid on its own, shared by every occurrence
    // of a recurring event, so grouping can key on it directly instead of stripping externalId.
    // The `feed:` prefix matches externalId's and keeps this source's ids out of the EventKit
    // source's space (`eventkit:{calendarItemIdentifier}`, CalendarReader.swift) — the two id
    // spaces are unrelated, and a meeting synced from both sources must not collide here.
    seriesId: `feed:${ev.uid}`,
  };
}

/**
 * The events of one iCalendar document that touch the window, recurrences expanded and
 * overrides applied. Cancelled events are dropped; a timezone the feed carries is honoured,
 * one it only names is read as UTC (Outlook always ships its VTIMEZONEs).
 */
export function parseCalendarFeed(ics: string, window: FeedWindow): { calendarTitle: string; events: CalendarEventInput[] } {
  // VTIMEZONEs are found through the component tree, so nothing is registered process-wide.
  const root = new ICAL.Component(ICAL.parse(ics));
  const calendarTitle = text(root, "x-wr-calname") || "Calendar feed";
  const masters: ICAL.Component[] = [];
  const exceptions = new Map<string, ICAL.Component[]>();
  for (const v of root.getAllSubcomponents("vevent")) {
    const uid = text(v, "uid");
    if (!uid) continue;
    if (v.hasProperty("recurrence-id")) {
      const list = exceptions.get(uid) ?? [];
      list.push(v);
      exceptions.set(uid, list);
    } else masters.push(v);
  }
  const from = window.from.getTime();
  const to = window.to.getTime();
  const events: CalendarEventInput[] = [];
  // Admission is by overlap, but the row's day is its start: a block that began before the
  // window is stored outside the purge range, the same shape the helper has.
  const overlaps = (s: ICAL.Time, e: ICAL.Time) => asInstant(e).toJSDate().getTime() > from && asInstant(s).toJSDate().getTime() < to;

  for (const comp of masters) {
    if (text(comp, "status").toUpperCase() === "CANCELLED") continue;
    // Without an explicit list ical.js relates every override in the file to every series,
    // whatever its UID; strict mode keeps each series to its own.
    const ev = new ICAL.Event(comp, { exceptions: exceptions.get(text(comp, "uid")) ?? [], strictExceptions: true });
    if (!ev.isRecurring()) {
      if (overlaps(ev.startDate, ev.endDate)) events.push(occurrenceInput(ev, ev.startDate, ev.endDate, `feed:${ev.uid}`, calendarTitle));
      continue;
    }
    const it = ev.iterator();
    let next: ICAL.Time | null;
    let steps = 0;
    while ((next = it.next()) && steps++ < MAX_STEPS) {
      if (asInstant(next).toJSDate().getTime() >= to) break;
      const d = ev.getOccurrenceDetails(next);
      if (text(d.item.component, "status").toUpperCase() === "CANCELLED") continue;
      if (!overlaps(d.startDate, d.endDate)) continue;
      const id = `feed:${ev.uid}:${asInstant(d.recurrenceId).toJSDate().toISOString()}`;
      events.push(occurrenceInput(d.item, d.startDate, d.endDate, id, calendarTitle));
      if (events.length >= MAX_OCCURRENCES) break;
    }
  }
  return { calendarTitle, events };
}

/** "fetch failed" says nothing; the cause underneath usually does. */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError") return "The link did not answer in time";
  if (err.message === "fetch failed") {
    const cause = (err as Error & { cause?: { message?: string; code?: string } }).cause;
    return `Could not reach the link${cause?.code ? ` (${cause.code})` : cause?.message ? `: ${cause.message}` : ""}`;
  }
  return err.message;
}

export type FeedSyncResult = { state: "off" } | { state: "ok"; count: number; syncedAt: string } | { state: "error"; error: string };

/**
 * Fetches the published link and replaces the feed's slice of the calendar. The result also
 * lands in settings, so the Meetings view can say when it last worked and what went wrong.
 */
export async function syncCalendarFeed(
  db: DB,
  deps: { fetch?: typeof globalThis.fetch; now?: Date; log?: (m: string) => void } = {},
): Promise<FeedSyncResult> {
  const url = getSetting(db, FEED_URL_KEY, "");
  if (!url) return { state: "off" };
  const now = deps.now ?? new Date();
  const doFetch = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? (() => {});
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "text/calendar" } });
    if (!res.ok) throw new Error(`The link answered ${res.status}`);
    const body = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(body)) throw new Error("That link is not a calendar feed");
    const today = localDay(now.toISOString());
    const from = addDays(today, -PAST_DAYS);
    const to = addDays(today, AHEAD_DAYS + 1);
    const { events } = parseCalendarFeed(body, { from: new Date(`${from}T00:00:00`), to: new Date(`${to}T00:00:00`) });
    replaceCalendarEvents(db, events, { from, to }, { calendarsSeen: 1 }, { source: "feed" });
    const syncedAt = now.toISOString();
    setSetting(db, SYNCED_AT_KEY, syncedAt);
    setSetting(db, ERROR_KEY, "");
    setSetting(db, COUNT_KEY, String(events.length));
    log(`synced ${events.length} event(s) from the calendar feed`);
    return { state: "ok", count: events.length, syncedAt };
  } catch (err) {
    const error = describeFetchError(err);
    setSetting(db, ERROR_KEY, error);
    log(`calendar feed failed: ${error}`);
    return { state: "error", error };
  }
}
