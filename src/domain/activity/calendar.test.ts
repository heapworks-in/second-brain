import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { eq } from "drizzle-orm";
import { activitySessions, calendarEvents } from "@/db/schema";
import { replaceCalendarEvents, findMeetingFor, isInterview, captureMeeting, labelMeetings, localDay, dayBounds, listMeetings, joinUrlFrom, callLinkFrom } from "./calendar";
import { ingestHeartbeat } from "./sessions";
import { parseMeta } from "@/domain/items";

const T0 = Date.parse("2026-09-16T09:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const zoom = (s: number) => ({ at: at(s), appId: "us.zoom.xos", appName: "zoom.us", title: "Zoom Meeting", url: null });

describe("calendar", () => {
  let t: TestDb;
  beforeEach(() => { t = makeTestDb(); });
  afterEach(() => t.cleanup());

  it("computes local days and bounds", () => {
    const day = localDay(at(0));
    const { start, end } = dayBounds(day);
    expect(Date.parse(end) - Date.parse(start)).toBe(86_400_000);
    expect(at(0) >= start && at(0) < end).toBe(true);
    expect(() => dayBounds("2026-9-1")).toThrow(/YYYY-MM-DD/);
  });

  it("replaces events per day and prefers call-link events on overlap", () => {
    const r = replaceCalendarEvents(t.db, [
      { externalId: "a", title: "Weekly sync", startsAt: at(0), endsAt: at(1800), attendees: 4, hasCallLink: false },
      { externalId: "b", title: "Interview: Jane", startsAt: at(600), endsAt: at(2400), attendees: 2, hasCallLink: true },
    ]);
    expect(r.inserted).toBe(2);
    expect(findMeetingFor(t.db, at(700))?.externalId).toBe("b");
    expect(findMeetingFor(t.db, at(100))?.externalId).toBe("a");
    expect(findMeetingFor(t.db, at(5000))).toBeUndefined();
    expect(findMeetingFor(t.db, at(0))?.externalId).toBe("a");
    replaceCalendarEvents(t.db, [{ externalId: "a", title: "Weekly sync (moved)", startsAt: at(0), endsAt: at(900), attendees: 4, hasCallLink: false }]);
    const rows = t.db.select().from(calendarEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Weekly sync (moved)");
  });

  it("labels meeting sessions on open and retroactively", () => {
    ingestHeartbeat(t.db, zoom(0));
    ingestHeartbeat(t.db, zoom(60));
    expect(t.db.select().from(activitySessions).get()?.meetingId).toBeNull();
    replaceCalendarEvents(t.db, [{ externalId: "a", title: "Weekly sync", startsAt: at(0), endsAt: at(1800), attendees: 4, hasCallLink: true }]);
    const ev = t.db.select().from(calendarEvents).get()!;
    expect(t.db.select().from(activitySessions).get()?.meetingId).toBe(ev.id);
    ingestHeartbeat(t.db, { at: at(2000), appId: "com.microsoft.VSCode", appName: "Code", title: "x", url: null });
    ingestHeartbeat(t.db, zoom(2100));
    const s = t.db.select().from(activitySessions).all();
    expect(s[2].meetingId).toBeNull();
    expect(labelMeetings(t.db, [localDay(at(0))])).toBe(0);
  });

  it("detects interviews and captures a meeting item once", () => {
    expect(isInterview("Interview: Jane")).toBe(true);
    expect(isInterview("Weekly sync")).toBe(false);
    replaceCalendarEvents(t.db, [{ externalId: "a", title: "Interview: Jane", startsAt: at(0), endsAt: at(1800), attendees: 2, hasCallLink: true }]);
    const ev = t.db.select().from(calendarEvents).get()!;
    const item = captureMeeting(t.db, ev.id);
    expect(item.type).toBe("meeting");
    expect(item.title).toBe("Interview: Jane");
    expect(parseMeta<{ calendarEventId: number }>(item).calendarEventId).toBe(ev.id);
    expect(item.body).toContain("2 attendees");
    expect(captureMeeting(t.db, ev.id).id).toBe(item.id);
    expect(() => captureMeeting(t.db, 999)).toThrow(/not found/);
  });

  it("stores the richer fields and derives a join url", () => {
    replaceCalendarEvents(t.db, [
      {
        externalId: "e1",
        title: "Sync",
        startsAt: "2026-09-22T09:00:00.000Z",
        endsAt: "2026-09-22T09:30:00.000Z",
        attendees: 3,
        hasCallLink: true,
        organizer: "Ada",
        attendeeNames: ["Ada", "Bo"],
        location: "Teams",
        joinUrl: null,
        notes: "Join: https://teams.microsoft.com/l/meetup-join/abc",
        allDay: false,
        status: "accepted",
        calendarTitle: "Work",
      },
    ]);
    const [ev] = listMeetings(t.db, { from: "2026-09-22", to: "2026-09-23" });
    expect(ev.organizer).toBe("Ada");
    expect(JSON.parse(ev.attendeeNames)).toEqual(["Ada", "Bo"]);
    expect(ev.joinUrl).toBe("https://teams.microsoft.com/l/meetup-join/abc");
    expect(ev.status).toBe("accepted");
    expect(ev.calendarTitle).toBe("Work");
    expect(ev.allDay).toBe(0);
    expect(ev.noRecord).toBe(0);
    expect(ev.itemId).toBeNull();
  });

  it("persists seriesId, refreshed on every sync like title, while a person's decision and note survive that same sync unchanged", () => {
    replaceCalendarEvents(t.db, [
      { externalId: "s1", title: "Recurring", startsAt: at(0), endsAt: at(1800), attendees: 1, hasCallLink: false, seriesId: "series-abc" },
    ]);
    const seeded = t.db.select().from(calendarEvents).where(eq(calendarEvents.externalId, "s1")).get()!;
    expect(seeded.seriesId).toBe("series-abc");

    // seriesId is calendar-owned, like title — a person's own decision and note are not, and
    // stay off the upsert's `set` the same way itemId/noRecord already do, so a resync must
    // leave them alone even while it changes everything the calendar actually owns.
    t.db.update(calendarEvents).set({ decision: "maybe", decisionNote: "checking my day" }).where(eq(calendarEvents.id, seeded.id)).run();

    replaceCalendarEvents(t.db, [
      { externalId: "s1", title: "Recurring (renamed)", startsAt: at(0), endsAt: at(1800), attendees: 1, hasCallLink: false, seriesId: "series-xyz" },
    ]);
    const resynced = t.db.select().from(calendarEvents).where(eq(calendarEvents.externalId, "s1")).get()!;
    expect(resynced.title).toBe("Recurring (renamed)");
    expect(resynced.seriesId).toBe("series-xyz"); // calendar-owned: refreshed, exactly like title.
    expect(resynced.decision).toBe("maybe"); // person-owned: untouched by the sync.
    expect(resynced.decisionNote).toBe("checking my day");

    // A resync that stops sending seriesId nulls it, the same as any other calendar-owned field.
    replaceCalendarEvents(t.db, [{ externalId: "s1", title: "Recurring (renamed)", startsAt: at(0), endsAt: at(1800), attendees: 1, hasCallLink: false }]);
    expect(t.db.select().from(calendarEvents).where(eq(calendarEvents.externalId, "s1")).get()!.seriesId).toBeNull();
  });

  it("lists meetings in a window with a text filter", () => {
    replaceCalendarEvents(t.db, [
      { externalId: "d1", title: "Design review", startsAt: "2026-09-22T09:00:00.000Z", endsAt: "2026-09-22T10:00:00.000Z", attendees: 2, hasCallLink: false, attendeeNames: ["Cy"] },
      { externalId: "d2", title: "Weekly sync", startsAt: "2026-09-24T09:00:00.000Z", endsAt: "2026-09-24T10:00:00.000Z", attendees: 5, hasCallLink: false, organizer: "Bo" },
    ]);
    expect(listMeetings(t.db, { from: "2026-09-20", to: "2026-09-30" }).map((e) => e.title)).toEqual(["Design review", "Weekly sync"]);
    expect(listMeetings(t.db, { from: "2026-09-20", to: "2026-09-30", q: "cy" }).map((e) => e.title)).toEqual(["Design review"]);
    expect(listMeetings(t.db, { from: "2026-09-20", to: "2026-09-30", q: "bo" }).map((e) => e.title)).toEqual(["Weekly sync"]);
    expect(listMeetings(t.db, { from: "2026-09-23", to: "2026-09-30" }).map((e) => e.title)).toEqual(["Weekly sync"]);
  });

  it("joinUrlFrom prefers meeting providers and falls back to any https url", () => {
    expect(joinUrlFrom("room 4", "https://zoom.us/j/1", "see https://example.com")).toBe("https://zoom.us/j/1");
    expect(joinUrlFrom(null, "notes https://example.com/x")).toBe("https://example.com/x");
    expect(joinUrlFrom("nothing")).toBeNull();
  });

  it("callLinkFrom answers only for a real provider, where joinUrlFrom would take any link", () => {
    for (const url of [
      "https://corp.zoom.us/j/9876543210",
      "https://teams.microsoft.com/l/meetup-join/xyz",
      "https://meet.google.com/abc-defg-hij",
      "https://acme.webex.com/meet/someone",
    ]) {
      expect(callLinkFrom("notes", `Join: ${url}`)).toBe(url);
    }
    // The links a work invite actually carries. Each one used to count as a call, which is what
    // made auto-record fire on agendas, tickets and lunch.
    for (const notes of [
      "Agenda: https://confluence.corp/x/AgendaPage",
      "Doc: https://docs.google.com/document/d/abc",
      "Board: https://jira.corp/browse/ENG-123",
      "https://maps.apple.com/?q=cafe",
    ]) {
      expect(callLinkFrom(null, notes)).toBeNull();
      expect(joinUrlFrom(null, notes)).not.toBeNull();
    }
  });

  it("stores hasCallLink from the call link, not from whatever url the invite happened to carry", () => {
    replaceCalendarEvents(t.db, [
      { externalId: "agenda", title: "1:1", startsAt: at(0), endsAt: at(1800), attendees: 2, hasCallLink: false, notes: "Agenda: https://confluence.corp/x/Page" },
      { externalId: "zoom", title: "Standup", startsAt: at(0), endsAt: at(1800), attendees: 5, hasCallLink: false, notes: "https://corp.zoom.us/j/1" },
    ]);
    const rows = t.db.select().from(calendarEvents).all();
    const agenda = rows.find((r) => r.externalId === "agenda")!;
    const zoom = rows.find((r) => r.externalId === "zoom")!;
    expect(agenda.hasCallLink).toBe(0);
    // The Join button still has somewhere to go -- it just does not mean "this is a call".
    expect(agenda.joinUrl).toBe("https://confluence.corp/x/Page");
    expect(zoom.hasCallLink).toBe(1);
  });

  it("keeps the row id, item_id, and no_record when an event is updated", () => {
    replaceCalendarEvents(t.db, [{ externalId: "a", title: "Weekly sync", startsAt: at(0), endsAt: at(1800), attendees: 4, hasCallLink: false }]);
    const ev = t.db.select().from(calendarEvents).get()!;
    const item = captureMeeting(t.db, ev.id);
    t.db.update(calendarEvents).set({ noRecord: 1 }).where(eq(calendarEvents.id, ev.id)).run();
    replaceCalendarEvents(t.db, [{ externalId: "a", title: "Weekly sync (moved)", startsAt: at(0), endsAt: at(900), attendees: 4, hasCallLink: false }]);
    const rows = t.db.select().from(calendarEvents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ev.id, title: "Weekly sync (moved)", endsAt: at(900), itemId: item.id, noRecord: 1 });
  });

  it("drops events that vanish from the window and leaves the ones outside it", () => {
    const inside = { externalId: "in", title: "Inside", startsAt: "2026-09-22T09:00:00.000Z", endsAt: "2026-09-22T10:00:00.000Z", attendees: 1, hasCallLink: false };
    const alsoInside = { externalId: "in2", title: "Also inside", startsAt: "2026-09-23T09:00:00.000Z", endsAt: "2026-09-23T10:00:00.000Z", attendees: 1, hasCallLink: false };
    const outside = { externalId: "out", title: "Outside", startsAt: "2026-10-05T09:00:00.000Z", endsAt: "2026-10-05T10:00:00.000Z", attendees: 1, hasCallLink: false };
    const window = { from: "2026-09-20", to: "2026-09-30" };
    replaceCalendarEvents(t.db, [inside, alsoInside], window);
    replaceCalendarEvents(t.db, [outside], { from: "2026-10-01", to: "2026-10-10" });
    const keptId = t.db.select().from(calendarEvents).where(eq(calendarEvents.externalId, "in")).get()!.id;

    const r = replaceCalendarEvents(t.db, [inside], window);
    expect(r.removed).toBe(1);
    const rows = t.db.select().from(calendarEvents).all();
    expect(rows.map((e) => e.externalId).sort()).toEqual(["in", "out"]);
    expect(rows.find((e) => e.externalId === "in")!.id).toBe(keptId);
  });

  it("keeps the window when an empty payload cannot prove the helper read the calendar", () => {
    const inside = { externalId: "in", title: "Inside", startsAt: "2026-09-22T09:00:00.000Z", endsAt: "2026-09-22T10:00:00.000Z", attendees: 1, hasCallLink: false };
    const window = { from: "2026-09-20", to: "2026-09-30" };
    replaceCalendarEvents(t.db, [inside], window);

    // A helper refused calendar access sees no events and reports no calendars: believing its
    // window would empty two months of meetings.
    const r = replaceCalendarEvents(t.db, [], window);
    expect(r.removed).toBe(0);
    expect(t.db.select().from(calendarEvents).all().map((e) => e.externalId)).toEqual(["in"]);

    // The same empty payload with the calendars-seen signal is a genuinely empty window.
    const cleared = replaceCalendarEvents(t.db, [], window, { calendarsSeen: 2 });
    expect(cleared.removed).toBe(1);
    expect(t.db.select().from(calendarEvents).all()).toHaveLength(0);
  });

  it("without a window a payload speaks only for the days it carries", () => {
    const monday = { externalId: "m", title: "Monday", startsAt: "2026-09-21T09:00:00.000Z", endsAt: "2026-09-21T10:00:00.000Z", attendees: 1, hasCallLink: false };
    const tuesday = { externalId: "t1", title: "Tuesday", startsAt: "2026-09-22T09:00:00.000Z", endsAt: "2026-09-22T10:00:00.000Z", attendees: 1, hasCallLink: false };
    const tuesdayToo = { externalId: "t2", title: "Tuesday too", startsAt: "2026-09-22T11:00:00.000Z", endsAt: "2026-09-22T12:00:00.000Z", attendees: 1, hasCallLink: false };
    replaceCalendarEvents(t.db, [monday, tuesday, tuesdayToo]);
    replaceCalendarEvents(t.db, [tuesday]);
    expect(t.db.select().from(calendarEvents).all().map((e) => e.externalId).sort()).toEqual(["m", "t1"]);
  });

  it("purges only its own source inside the window", () => {
    const window = { from: "2026-09-16", to: "2026-09-17" };
    replaceCalendarEvents(t.db, [{ externalId: "ek", title: "Helper", startsAt: at(0), endsAt: at(1800), attendees: 1, hasCallLink: false }], window, { calendarsSeen: 1 });
    replaceCalendarEvents(t.db, [{ externalId: "feed:x", title: "Feed", startsAt: at(0), endsAt: at(1800), attendees: 1, hasCallLink: false }], window, { calendarsSeen: 1 }, { source: "feed" });
    // The helper posts the same window again: the feed's row is not its to remove.
    const r = replaceCalendarEvents(t.db, [{ externalId: "ek", title: "Helper", startsAt: at(0), endsAt: at(1800), attendees: 1, hasCallLink: false }], window, { calendarsSeen: 1 });
    expect(r.removed).toBe(0);
    const ids = t.db.select().from(calendarEvents).all().map((e) => [e.externalId, e.source]);
    expect(ids).toEqual(expect.arrayContaining([["ek", "eventkit"], ["feed:x", "feed"]]));
    // An empty feed with proof purges the feed row alone.
    expect(replaceCalendarEvents(t.db, [], window, { calendarsSeen: 1 }, { source: "feed" }).removed).toBe(1);
    expect(t.db.select().from(calendarEvents).all().map((e) => e.externalId)).toEqual(["ek"]);
  });
});
