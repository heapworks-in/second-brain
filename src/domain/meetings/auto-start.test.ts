import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { calendarEvents, type CalendarEvent } from "@/db/schema";
import { makeTestDb, type TestDb } from "@/test/db";
import { createItem, getItem, parseMeta } from "@/domain/items";
import { replaceCalendarEvents, setMeetingNoRecord, type CalendarEventInput } from "@/domain/activity/calendar";
import { setMeetingDecision } from "./decision";
import { setSetting } from "@/domain/settings";
import { Recorder, type RecordingMeta } from "./recorder";
import { recorderStatus, keepRecording, setRecorder, startRecording } from "./index";
import { autoStartTick, autoStopDue, getAutoRecordSettings, MAX_AUTO_MS, pickAutoStart, setAutoRecordSettings } from "./auto-start";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_RECORDER = path.join(here, "..", "..", "test", "fake-recorder.js");

/** A fixed "now" in local time, so the day strings the query uses are the fixtures' days. */
const NOW = new Date();
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const ON = { autoRecord: true, autoRecordNeedsCallLink: true };

function event(over: Partial<CalendarEventInput> & { externalId: string; title: string; startsAt: string }): CalendarEventInput {
  return {
    endsAt: new Date(Date.parse(over.startsAt) + 30 * 60_000).toISOString(),
    attendees: 3,
    hasCallLink: true,
    joinUrl: "https://meet.example.com/x",
    ...over,
  };
}

function byTitle(t: TestDb, title: string): CalendarEvent {
  return t.db.select().from(calendarEvents).where(eq(calendarEvents.title, title)).get()!;
}

describe("pickAutoStart", () => {
  let t: TestDb;

  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  /** Every exclusion starts before the match, so a leak returns the wrong meeting, not none. */
  function seedExclusionsAndOneMatch(): void {
    replaceCalendarEvents(t.db, [
      event({ externalId: "gone", title: "Ended long ago", startsAt: at(-10) }),
      event({ externalId: "declined", title: "Declined", startsAt: at(-2), status: "declined" }),
      event({ externalId: "allday", title: "All day", startsAt: at(-2), allDay: true }),
      event({ externalId: "nolink", title: "No link", startsAt: at(-1), joinUrl: null, hasCallLink: false }),
      event({ externalId: "recorded", title: "Already recorded", startsAt: at(-1) }),
      event({ externalId: "norecord", title: "Not this one", startsAt: at(-1) }),
      event({ externalId: "match", title: "Weekly sync", startsAt: at(0) }),
      event({ externalId: "later", title: "Too far ahead", startsAt: at(5) }),
    ]);
    const recorded = createItem(t.db, {
      type: "meeting",
      title: "Already recorded",
      meta: { recording: { startedAt: at(-1), wavPath: "meetings/1.wav", state: "done", autoStarted: false } satisfies RecordingMeta },
    });
    t.db.update(calendarEvents).set({ itemId: recorded.id }).where(eq(calendarEvents.externalId, "recorded")).run();
    setMeetingNoRecord(t.db, byTitle(t, "Not this one").id, true);
  }

  it("takes the meeting starting now and skips declined, all-day, linkless, recorded, no-record, and out-of-window", () => {
    seedExclusionsAndOneMatch();
    expect(pickAutoStart(t.db, NOW, ON)?.title).toBe("Weekly sync");
  });

  it("does not auto-record a meeting marked maybe -- auto-record only fires for a clear yes", () => {
    replaceCalendarEvents(t.db, [event({ externalId: "maybe", title: "Might join", startsAt: at(0) })]);
    setMeetingDecision(t.db, byTitle(t, "Might join").id, { decision: "maybe", scope: "occurrence" });
    expect(pickAutoStart(t.db, NOW, ON)).toBeNull();
  });

  it("does not auto-record a meeting whose series was declined, even with no per-occurrence override", () => {
    replaceCalendarEvents(t.db, [
      event({ externalId: "series-a", title: "Recurring standup (last week)", startsAt: at(-1440), seriesId: "eventkit:series-1" }),
      event({ externalId: "series-b", title: "Recurring standup (today)", startsAt: at(0), seriesId: "eventkit:series-1" }),
    ]);
    setMeetingDecision(t.db, byTitle(t, "Recurring standup (last week)").id, { decision: "not-going", scope: "series" });
    expect(pickAutoStart(t.db, NOW, ON)).toBeNull();
  });

  it("skips a meeting whose only link is an agenda, and takes the one with a real call link", () => {
    // What a work calendar is mostly made of: every invite carries *some* url. Gating on that url
    // recorded all of them, which is the whole reason this rule exists.
    replaceCalendarEvents(t.db, [
      event({ externalId: "agenda", title: "1:1 with my manager", startsAt: at(-1), hasCallLink: false, joinUrl: null, notes: "Agenda: https://confluence.corp/x/Page" }),
      event({ externalId: "ticket", title: "Sprint planning", startsAt: at(-1), hasCallLink: false, joinUrl: null, notes: "https://jira.corp/browse/ENG-1" }),
      event({ externalId: "zoom", title: "Design review", startsAt: at(0), hasCallLink: false, joinUrl: null, notes: "Join: https://corp.zoom.us/j/1" }),
    ]);
    expect(pickAutoStart(t.db, NOW, ON)?.title).toBe("Design review");
  });

  it("auto-records each provider the EventKit helper recognises", () => {
    for (const [i, url] of [
      "https://corp.zoom.us/j/1",
      "https://teams.microsoft.com/l/meetup-join/x",
      "https://meet.google.com/abc-defg-hij",
      "https://acme.webex.com/meet/x",
    ].entries()) {
      const fresh = makeTestDb();
      try {
        replaceCalendarEvents(fresh.db, [event({ externalId: `p${i}`, title: "Call", startsAt: at(0), hasCallLink: false, joinUrl: null, notes: url })]);
        expect(pickAutoStart(fresh.db, NOW, ON)?.title).toBe("Call");
      } finally {
        fresh.cleanup();
      }
    }
  });

  it("takes a linkless meeting once the call-link rule is off", () => {
    replaceCalendarEvents(t.db, [event({ externalId: "nolink", title: "Desk chat", startsAt: at(0), joinUrl: null, hasCallLink: false })]);
    expect(pickAutoStart(t.db, NOW, ON)).toBeNull();
    expect(pickAutoStart(t.db, NOW, { autoRecord: true, autoRecordNeedsCallLink: false })?.title).toBe("Desk chat");
  });

  it("holds the window at two minutes late and one minute early, and picks nothing while auto-record is off", () => {
    replaceCalendarEvents(t.db, [event({ externalId: "m", title: "Standup", startsAt: at(0) })]);
    const ev = byTitle(t, "Standup");
    const start = new Date(Date.parse(ev.startsAt));
    const after = (ms: number) => new Date(start.getTime() + ms);
    expect(pickAutoStart(t.db, after(2 * 60_000), ON)?.id).toBe(ev.id);
    expect(pickAutoStart(t.db, after(2 * 60_000 + 1000), ON)).toBeNull();
    expect(pickAutoStart(t.db, after(-60_000), ON)?.id).toBe(ev.id);
    expect(pickAutoStart(t.db, after(-61_000), ON)).toBeNull();
    expect(pickAutoStart(t.db, start, { autoRecord: false, autoRecordNeedsCallLink: true })).toBeNull();
  });

  it("reads and writes the two settings, off and link-only by default", () => {
    expect(getAutoRecordSettings(t.db)).toEqual({ autoRecord: false, autoRecordNeedsCallLink: true });
    expect(setAutoRecordSettings(t.db, { autoRecord: true })).toEqual({ autoRecord: true, autoRecordNeedsCallLink: true });
    expect(setAutoRecordSettings(t.db, { autoRecordNeedsCallLink: false })).toEqual({ autoRecord: true, autoRecordNeedsCallLink: false });
    expect(getAutoRecordSettings(t.db)).toEqual({ autoRecord: true, autoRecordNeedsCallLink: false });
  });
});

describe("the auto-record tick", () => {
  let t: TestDb;
  let recorder: Recorder;

  beforeEach(() => {
    t = makeTestDb();
    recorder = new Recorder({ db: t.db, recorderBin: FAKE_RECORDER, whisperBin: null, baseModel: null, filesDir: path.join(t.dir, "files") });
    setRecorder(recorder);
    setSetting(t.db, "meetings.autoRecord", "1");
  });

  afterEach(async () => {
    await recorder.stop();
    setRecorder(null);
    t.cleanup();
  });

  it("starts the meeting that is beginning, and marks the recording as auto-started", async () => {
    replaceCalendarEvents(t.db, [event({ externalId: "m", title: "Weekly sync", startsAt: at(0) })]);

    await autoStartTick(t.db, { now: () => NOW });

    const status = recorderStatus();
    expect(status.state).toBe("recording");
    expect(status.title).toBe("Weekly sync");
    expect(status.autoStarted).toBe(true);
    const item = getItem(t.db, status.itemId!)!;
    expect(parseMeta<{ recording?: RecordingMeta }>(item).recording?.autoStarted).toBe(true);
  });

  it("stops an auto-started session five minutes after the meeting ended", async () => {
    replaceCalendarEvents(t.db, [event({ externalId: "m", title: "Weekly sync", startsAt: at(0) })]);
    const ev = byTitle(t, "Weekly sync");
    startRecording(t.db, { calendarEventId: ev.id }, { autoStarted: true });
    const end = Date.parse(ev.endsAt);

    await autoStartTick(t.db, { now: () => new Date(end + 4 * 60_000) });
    expect(recorderStatus().state).toBe("recording");

    await autoStartTick(t.db, { now: () => new Date(end + 6 * 60_000) });
    expect(recorderStatus().state).toBe("idle");
  });

  it("hands the machine to the next meeting rather than spending its window on the grace tail", async () => {
    // 10:00-10:30 then 10:30-11:00: the first session's five-minute tail outlasts the second
    // meeting's start window, so without this the 10:30 meeting is never recorded.
    replaceCalendarEvents(t.db, [event({ externalId: "a", title: "First", startsAt: at(-30) }), event({ externalId: "b", title: "Second", startsAt: at(0) })]);
    const first = byTitle(t, "First");
    startRecording(t.db, { calendarEventId: first.id }, { autoStarted: true });
    const firstItem = recorderStatus().itemId!;

    await autoStartTick(t.db, { now: () => new Date(NOW.getTime() + 30_000) });

    const status = recorderStatus();
    expect(status.state).toBe("recording");
    expect(status.title).toBe("Second");
    expect(status.autoStarted).toBe(true);
    expect(status.itemId).not.toBe(firstItem);
    expect(parseMeta<{ recording?: RecordingMeta }>(getItem(t.db, firstItem)!).recording?.state).toBe("done");
  });

  it("never takes the machine off a session a person started, or one they asked to keep", async () => {
    replaceCalendarEvents(t.db, [event({ externalId: "a", title: "First", startsAt: at(-30) }), event({ externalId: "b", title: "Second", startsAt: at(0) })]);
    const first = byTitle(t, "First");
    startRecording(t.db, { calendarEventId: first.id });
    const soon = () => new Date(NOW.getTime() + 30_000);

    await autoStartTick(t.db, { now: soon });
    expect(recorderStatus().title).toBe("First");

    await recorder.stop();
    startRecording(t.db, { calendarEventId: first.id }, { autoStarted: true });
    keepRecording();
    await autoStartTick(t.db, { now: soon });
    expect(recorderStatus().title).toBe("First");
  });

  it("stops an auto-started session after three hours once its calendar row has gone", async () => {
    replaceCalendarEvents(t.db, [event({ externalId: "m", title: "Weekly sync", startsAt: at(0) })]);
    const ev = byTitle(t, "Weekly sync");
    startRecording(t.db, { calendarEventId: ev.id }, { autoStarted: true });
    const status = recorderStatus();
    // The meeting is cancelled mid-recording and the row goes with the next sync.
    t.db.delete(calendarEvents).where(eq(calendarEvents.id, ev.id)).run();
    const started = Date.parse(status.startedAt!);

    expect(autoStopDue(status, t.db, new Date(started + 2 * 60 * 60_000))).toBe(false);
    expect(autoStopDue(status, t.db, new Date(started + MAX_AUTO_MS + 1000))).toBe(true);

    await autoStartTick(t.db, { now: () => new Date(started + MAX_AUTO_MS + 1000) });
    expect(recorderStatus().state).toBe("idle");
  });

  it("leaves a kept session running past the end, and never stops one a person started", async () => {
    replaceCalendarEvents(t.db, [event({ externalId: "m", title: "Weekly sync", startsAt: at(0) })]);
    const ev = byTitle(t, "Weekly sync");
    startRecording(t.db, { calendarEventId: ev.id }, { autoStarted: true });
    const late = new Date(Date.parse(ev.endsAt) + 6 * 60_000);
    expect(keepRecording().keep).toBe(true);

    await autoStartTick(t.db, { now: () => late });
    expect(recorderStatus().state).toBe("recording");
    expect(autoStopDue(recorderStatus(), t.db, late)).toBe(false);

    await recorder.stop();
    startRecording(t.db, { calendarEventId: ev.id });
    expect(autoStopDue(recorderStatus(), t.db, late)).toBe(false);
  });
});
