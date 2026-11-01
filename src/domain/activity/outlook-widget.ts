import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DB } from "@/db/client";
import type { CalendarEventInput } from "./calendar";
import { callLinkFrom, joinUrlFrom, localDay, replaceCalendarEvents } from "./calendar";
import { eq, sql } from "drizzle-orm";
import { calendarEvents } from "@/db/schema";
import { getSetting, setSetting } from "@/domain/settings";
import type { MeetingStatus } from "@/db/schema";

/**
 * Outlook for Mac keeps its calendar in its own store and never publishes it to EventKit, so the
 * meetings people actually care about are invisible to the EventKit reader in `helper/activity`.
 * The one place they surface locally is the cache the Calendar widget keeps for its own rendering.
 *
 * That file is a private Outlook implementation detail: undocumented, and free to change shape or
 * move on any Outlook update. So everything here treats it as untrusted input and degrades to
 * "no events" rather than throwing -- the calendar feature keeps working off EventKit either way,
 * which is the same "off, not broken" shape the local models use.
 */
export const OUTLOOK_WIDGET_STORE =
  "Library/Group Containers/UBF8T346G9.Office/Library/Application Support/Calendar Widget/store.json";

/** Core Foundation's epoch (2001-01-01) against Unix's (1970-01-01), in seconds. */
const CF_EPOCH_OFFSET = 978_307_200;

export function macTimeToIso(seconds: number): string {
  return new Date((seconds + CF_EPOCH_OFFSET) * 1000).toISOString();
}

interface RawEvent {
  stableAppointmentID?: unknown;
  subject?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  location?: unknown;
  notes?: unknown;
  isAllDay?: unknown;
  isCancelled?: unknown;
  calendar?: { name?: unknown } | unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function calendarName(event: RawEvent): string | undefined {
  const cal = event.calendar;
  if (cal && typeof cal === "object" && "name" in cal) return str((cal as { name?: unknown }).name);
  return undefined;
}

/**
 * `dayToAppointments` is a flat, interleaved array -- `[dayTimestamp, [events], dayTimestamp,
 * [events], ...]` -- not an array of pairs and not an object keyed by day. Walking it two at a
 * time is the whole trick; the day timestamps themselves are redundant with each event's own
 * startTime, so they are used only to find the event arrays.
 */
function eventsFrom(dayToAppointments: unknown): RawEvent[] {
  if (!Array.isArray(dayToAppointments)) return [];
  const out: RawEvent[] = [];
  for (let i = 1; i < dayToAppointments.length; i += 2) {
    const slot = dayToAppointments[i];
    if (Array.isArray(slot)) {
      for (const event of slot) {
        if (event && typeof event === "object") out.push(event as RawEvent);
      }
    }
  }
  return out;
}

/**
 * Outlook's cache carries no recurrence rule, so a series has to be inferred: the same title
 * appearing on two or more distinct local days is treated as recurring, and every occurrence of it
 * shares one `seriesId`. A title on a single day stays a "series of one", matching how the
 * EventKit reader treats non-recurring events.
 *
 * This is a heuristic and will group two genuinely unrelated meetings that happen to share a title
 * (a second "Standup" on another team). That is the accepted trade for having any series grouping
 * at all from a source that does not expose one, and it errs toward grouping rather than splitting
 * -- the audit that consumes seriesId is about recognising a recurring commitment, where an
 * over-broad group is far less misleading than the same meeting appearing as N unrelated ones.
 */
function seriesIds(events: RawEvent[]): Map<string, string> {
  const daysByTitle = new Map<string, Set<string>>();
  for (const event of events) {
    const title = str(event.subject);
    const start = typeof event.startTime === "number" ? event.startTime : undefined;
    if (!title || start === undefined) continue;
    const day = localDay(macTimeToIso(start));
    const days = daysByTitle.get(title) ?? new Set<string>();
    days.add(day);
    daysByTitle.set(title, days);
  }
  const ids = new Map<string, string>();
  for (const [title, days] of daysByTitle) {
    if (days.size >= 2) ids.set(title, `outlook-series:${title}`);
  }
  return ids;
}

/**
 * Every usable meeting in the widget cache, as the same `CalendarEventInput` the EventKit reader
 * produces. Cancelled events are dropped rather than carried as `cancelled`: unlike EventKit,
 * this cache keeps no tombstone once Outlook drops them, so a cancelled row here would linger
 * until the next full sync happened to still see it.
 */
export function parseOutlookWidgetStore(raw: unknown): CalendarEventInput[] {
  if (!raw || typeof raw !== "object") return [];
  const store = raw as { dayToAppointments?: unknown };
  const events = eventsFrom(store.dayToAppointments);
  const series = seriesIds(events);
  const seen = new Set<string>();
  const out: CalendarEventInput[] = [];

  for (const event of events) {
    const id = str(event.stableAppointmentID);
    const title = str(event.subject);
    const start = typeof event.startTime === "number" ? event.startTime : undefined;
    const end = typeof event.endTime === "number" ? event.endTime : undefined;
    if (!id || !title || start === undefined || end === undefined) continue;
    if (event.isCancelled === true) continue;

    // Two different duplications arrive through this cache and they need opposite treatment. The
    // same appointment is listed under every day it spans -- genuinely one meeting, so the repeat
    // must be dropped. A recurring series also repeats its stableAppointmentID across occurrences
    // -- genuinely different meetings, each with its own time, its own recording and its own
    // decision, so collapsing them loses twelve of thirteen weeks and makes every occurrence
    // resolve to the first one's captured item.
    //
    // Keying on the id *and* the occurrence start separates them: a day-spanning repeat matches on
    // both and is skipped, distinct occurrences differ on the start and are kept.
    const externalId = `outlook:${id}:${macTimeToIso(start)}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const location = str(event.location);
    const notes = str(event.notes);
    const joinUrl = joinUrlFrom(location, notes);
    const isCall = callLinkFrom(location, notes) !== null;

    out.push({
      externalId,
      title,
      startsAt: macTimeToIso(start),
      endsAt: macTimeToIso(end),
      attendees: 0,
      hasCallLink: isCall,
      location,
      joinUrl,
      notes,
      allDay: event.isAllDay === true,
      // Deliberately not derived from Outlook's `responseStatus`. That is an undocumented integer
      // enum, and MeetingStatus here is an RSVP ("accepted" | "tentative" | "declined" | "none") --
      // guessing the mapping risks showing "declined" against a meeting the person accepted, which
      // is worse than showing no RSVP at all. Left as "none" until the enum is actually known.
      status: "none" satisfies MeetingStatus,
      calendarTitle: calendarName(event),
      // Deliberately the appointment id without the occurrence, not `externalId`, which now
      // carries the start: a series identity that changed every week would group nothing. It also
      // catches a recurring series whose title drifts between occurrences, which the title
      // heuristic above cannot see.
      seriesId: series.get(title) ?? `outlook:${id}`,
    });
  }
  return out;
}

const ENABLED_KEY = "calendar.outlookEnabled";
const SYNCED_AT_KEY = "calendar.outlookSyncedAt";
const ERROR_KEY = "calendar.outlookError";
const COUNT_KEY = "calendar.outlookCount";

export interface OutlookSyncResult {
  state: "off" | "ok" | "error";
  count?: number;
  syncedAt?: string;
  error?: string;
}

export function outlookStorePath(home = os.homedir()): string {
  return path.join(home, OUTLOOK_WIDGET_STORE);
}

export interface OutlookState {
  enabled: boolean;
  /** Whether Outlook's cache is actually there, so the UI can tell "switched off" from "nothing
   * to read" rather than showing an enabled toggle that silently does nothing. */
  available: boolean;
  syncedAt: string | null;
  error: string | null;
  count: number;
  /** Rows currently attributed to this source -- what "turn it off and clean up" would remove. */
  stored: number;
}

/**
 * Off unless explicitly switched on. Anyone who has added their Exchange account to macOS
 * Internet Accounts already gets these meetings through EventKit, and syncing both sources
 * produces two rows for every meeting -- so this stays opt-in rather than defaulting to a state
 * that silently duplicates a working calendar.
 */
export function isOutlookEnabled(db: DB): boolean {
  return getSetting(db, ENABLED_KEY, "") === "1";
}

export function getOutlookState(db: DB, home = os.homedir()): OutlookState {
  const stored = db
    .select({ n: sql<number>`count(*)` })
    .from(calendarEvents)
    .where(eq(calendarEvents.source, "outlook"))
    .get();
  return {
    enabled: isOutlookEnabled(db),
    available: fs.existsSync(outlookStorePath(home)),
    syncedAt: getSetting(db, SYNCED_AT_KEY, "") || null,
    error: getSetting(db, ERROR_KEY, "") || null,
    count: Number(getSetting(db, COUNT_KEY, "0")) || 0,
    stored: stored?.n ?? 0,
  };
}

/**
 * Removes every meeting this source put in the database. Scoped by `source` alone and not by any
 * window, because the point is to undo this integration completely -- including occurrences that
 * have aged out of whatever window the widget currently caches. EventKit's and the feed's rows
 * are a different source and are never touched.
 */
export function clearOutlookEvents(db: DB): number {
  const removed = db.delete(calendarEvents).where(eq(calendarEvents.source, "outlook")).run().changes;
  setSetting(db, COUNT_KEY, "0");
  setSetting(db, SYNCED_AT_KEY, "");
  setSetting(db, ERROR_KEY, "");
  return removed;
}

/**
 * Switching this off deletes what it synced. Leaving the rows behind would be worse than useless:
 * they would sit there permanently stale, never refreshed and never removed, duplicating whatever
 * EventKit reports for the same meetings.
 */
export function setOutlookEnabled(db: DB, enabled: boolean): { removed: number } {
  setSetting(db, ENABLED_KEY, enabled ? "1" : "");
  return { removed: enabled ? 0 : clearOutlookEvents(db) };
}

/**
 * Reads Outlook's widget cache and folds it into the same `calendar_events` table EventKit and the
 * subscribed feed already write to, under its own `outlook` source so neither call can delete the
 * other's rows.
 *
 * "No file" is the normal case, not a failure: it only exists when someone runs Outlook for Mac
 * with the Calendar widget, so this returns `off` and records nothing rather than reporting an
 * error people would have to dismiss forever.
 *
 * The sync window is derived from the events themselves rather than a fixed span around today,
 * because the widget only caches what it needs to draw -- claiming a wider window would delete
 * real meetings that Outlook simply had not cached yet.
 */
export function syncOutlookWidget(
  db: DB,
  deps: { home?: string; now?: Date; log?: (m: string) => void } = {},
): OutlookSyncResult {
  const file = outlookStorePath(deps.home);
  const now = deps.now ?? new Date();
  const log = deps.log ?? (() => {});
  if (!isOutlookEnabled(db)) return { state: "off" };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "off" };
  }
  try {
    const events = parseOutlookWidgetStore(JSON.parse(raw));
    if (events.length === 0) {
      // A readable file with nothing usable in it is still a working sync, but writing an empty
      // window would delete every Outlook row this source had previously stored.
      setSetting(db, SYNCED_AT_KEY, now.toISOString());
      setSetting(db, ERROR_KEY, "");
      setSetting(db, COUNT_KEY, "0");
      return { state: "ok", count: 0, syncedAt: now.toISOString() };
    }
    const days = events.map((e) => localDay(e.startsAt)).sort();
    const from = days[0];
    const to = days[days.length - 1];
    replaceCalendarEvents(db, events, { from, to }, { calendarsSeen: 1 }, { source: "outlook" });
    const syncedAt = now.toISOString();
    setSetting(db, SYNCED_AT_KEY, syncedAt);
    setSetting(db, ERROR_KEY, "");
    setSetting(db, COUNT_KEY, String(events.length));
    log(`synced ${events.length} event(s) from the Outlook calendar widget`);
    return { state: "ok", count: events.length, syncedAt };
  } catch (err) {
    // Reaching here means the file exists but is not the shape this parser knows -- most likely an
    // Outlook update changed it. Record it and leave the previously synced rows alone.
    const error = err instanceof Error ? err.message : String(err);
    setSetting(db, ERROR_KEY, error);
    log(`Outlook calendar widget sync failed: ${error}`);
    return { state: "error", error };
  }
}
