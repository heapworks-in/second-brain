import { eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { calendarEvents, type CalendarEvent } from "@/db/schema";
import { findCapturedMeetingItem, listMeetings, localDay } from "@/domain/activity/calendar";
import { effectiveDecision, seriesDecisionsFor } from "@/domain/meetings/decision";
import { parseMeta } from "@/domain/items";
import { getSetting, setSetting } from "@/domain/settings";
import type { RecorderStatus, RecordingMeta } from "./recorder";
import { recorderStatus, startRecording, stopRecording } from "./index";

/** How late a meeting can be joined and still be picked up, and how early the rule may jump in. */
const LATE_MS = 2 * 60_000;
const EARLY_MS = 60_000;
/** The tail a meeting gets before an auto-started session is stopped. */
export const AUTO_STOP_GRACE_MS = 5 * 60_000;
/** The ceiling an auto-started session gets when its calendar row has gone and there is no end time left to read. */
export const MAX_AUTO_MS = 3 * 60 * 60_000;

const AUTO_RECORD_KEY = "meetings.autoRecord";
const NEEDS_CALL_LINK_KEY = "meetings.autoRecordNeedsCallLink";

export interface AutoRecordSettings {
  /** Off until someone turns it on: nothing records itself by surprise. */
  autoRecord: boolean;
  /** On by default, so a desk conversation in the diary is not recorded. Means a Zoom, Teams,
   * Meet or Webex link specifically -- `hasCallLink`, not merely some url in the invite. */
  autoRecordNeedsCallLink: boolean;
}

export function getAutoRecordSettings(db: DB): AutoRecordSettings {
  return {
    autoRecord: getSetting(db, AUTO_RECORD_KEY, "0") === "1",
    autoRecordNeedsCallLink: getSetting(db, NEEDS_CALL_LINK_KEY, "1") === "1",
  };
}

/** Writes the keys the patch carries and returns both, which is what the route answers with. */
export function setAutoRecordSettings(db: DB, patch: Partial<AutoRecordSettings>): AutoRecordSettings {
  if (patch.autoRecord !== undefined) setSetting(db, AUTO_RECORD_KEY, patch.autoRecord ? "1" : "0");
  if (patch.autoRecordNeedsCallLink !== undefined) setSetting(db, NEEDS_CALL_LINK_KEY, patch.autoRecordNeedsCallLink ? "1" : "0");
  return getAutoRecordSettings(db);
}

/** True once a session has been hung on the event's item: a meeting is recorded once. */
function alreadyRecorded(db: DB, ev: CalendarEvent): boolean {
  // The same lookup capture uses, so an item found through meta.calendarEventId counts too.
  const item = findCapturedMeetingItem(db, ev.id);
  if (!item) return false;
  return !!parseMeta<{ recording?: RecordingMeta }>(item).recording;
}

/**
 * The meeting the rule would start recording at `now`, or null. Only a meeting that is
 * starting counts — two minutes late through one minute early — and it must be one the
 * person would record by hand: not an all-day block, not marked no-record, not already
 * recorded, decided `going` (a clear yes — `maybe` is recordable by hand but never auto-started,
 * and a series declined with no per-occurrence override still resolves to `not-going`), and,
 * while the call-link rule is on, one that is actually a call: a Zoom, Teams, Meet or Webex link.
 */
export function pickAutoStart(db: DB, now: Date, settings: AutoRecordSettings): CalendarEvent | null {
  if (!settings.autoRecord) return null;
  const earliest = now.getTime() - LATE_MS;
  const latest = now.getTime() + EARLY_MS;
  // The window can straddle local midnight, so ask for both days; `to` is exclusive.
  const from = localDay(new Date(earliest).toISOString());
  // The next calendar day, not 24 h later: on the fall-back day 24 h stays on the same day.
  const last = new Date(latest);
  const to = localDay(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).toISOString());
  const events = listMeetings(db, { from, to });
  // One batched series-decision query for the whole window, not one per candidate meeting.
  const seriesIds = [...new Set(events.map((ev) => ev.seriesId).filter((id): id is string => id !== null))];
  const decisions = seriesDecisionsFor(db, seriesIds);
  for (const ev of events) {
    const start = Date.parse(ev.startsAt);
    if (start < earliest || start > latest) continue;
    const decision = effectiveDecision(ev, ev.seriesId ? (decisions.get(ev.seriesId) ?? null) : null);
    if (ev.allDay || ev.noRecord || decision !== "going") continue;
    // `hasCallLink`, not `joinUrl`: the latter falls back to any url in the invite (see
    // `joinUrlFrom`), so gating on it meant an agenda page or a Jira ticket in the body was
    // enough to record a desk conversation. Only a recognised provider counts now. Recording by
    // hand is unaffected -- the button records whatever is in front of you.
    if (settings.autoRecordNeedsCallLink && ev.hasCallLink !== 1) continue;
    if (alreadyRecorded(db, ev)) continue;
    return ev;
  }
  return null;
}

/**
 * Whether the running session has outstayed its meeting. Only a session the rule started is
 * ever stopped for someone, and only while nobody has said to keep it; the status carries no
 * end time, so the meeting is found back through the item it is recording into.
 */
export function autoStopDue(status: RecorderStatus, db: DB, now: Date): boolean {
  if (status.state !== "recording" || !status.autoStarted || status.keep) return false;
  if (status.itemId === undefined) return false;
  const ev = db.select().from(calendarEvents).where(eq(calendarEvents.itemId, status.itemId)).get();
  if (!ev) {
    // The row can be purged mid-recording — the meeting was cancelled, or a sync dropped it —
    // and with it the end time this rule measures against. A session the rule started must
    // still end by itself, so it gets a ceiling instead of running until the machine sleeps.
    if (!status.startedAt) return false;
    return now.getTime() > Date.parse(status.startedAt) + MAX_AUTO_MS;
  }
  return now.getTime() > Date.parse(ev.endsAt) + AUTO_STOP_GRACE_MS;
}

/**
 * Whether the running session is recording `ev` already. `pickAutoStart` skips a meeting that
 * has been recorded, so it normally never returns the live one; this is the belt to that
 * brace, and it looks the item up the way capture does, through meta.calendarEventId too.
 */
function isRecording(db: DB, status: RecorderStatus, ev: CalendarEvent): boolean {
  return findCapturedMeetingItem(db, ev.id)?.id === status.itemId;
}

/**
 * One pass of the scheduler: stop a session that has outstayed its meeting, hand the machine
 * over to the meeting that is starting, or start that meeting. Nothing here throws: an
 * interval has nobody to catch it.
 */
export async function autoStartTick(db: DB, deps: { now?: () => Date; log?: (message: string) => void } = {}): Promise<void> {
  const now = deps.now?.() ?? new Date();
  try {
    let status = recorderStatus();
    if (status.state === "recording" || status.state === "stopping") {
      if (autoStopDue(status, db, now)) {
        deps.log?.(`stopping "${status.title ?? "recording"}": the meeting ended more than five minutes ago`);
        await stopRecording();
        return;
      }
      // Ruling: back to back meetings: the five-minute grace tail yields to the next meeting,
      // which would otherwise miss its whole window. Only a session the rule started is taken
      // over — never one a person started, and never one they have asked to keep.
      if (status.state !== "recording" || !status.autoStarted || status.keep) return;
      const next = pickAutoStart(db, now, getAutoRecordSettings(db));
      if (!next || isRecording(db, status, next)) return;
      deps.log?.(`stopping "${status.title ?? "recording"}": "${next.title}" is starting`);
      await stopRecording();
      status = recorderStatus();
      if (status.state === "error") await stopRecording();
      startRecording(db, { calendarEventId: next.id }, { autoStarted: true });
      deps.log?.(`recording "${next.title}"`);
      return;
    }
    const ev = pickAutoStart(db, now, getAutoRecordSettings(db));
    if (!ev) return;
    // A failed session is only a message on the chip; clearing it is what lets the next one start.
    if (status.state === "error") await stopRecording();
    startRecording(db, { calendarEventId: ev.id }, { autoStarted: true });
    deps.log?.(`recording "${ev.title}"`);
  } catch (err) {
    deps.log?.(`could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
}
