import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { calendarEvents, items, meetingSeriesDecisions } from "@/db/schema";
import { setSetting } from "@/domain/settings";
import { meetingUnprepared } from "./meeting-unprepared";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");

/** Minutes from `NOW`, as the ISO string the column holds. */
function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

function event(over: Partial<typeof calendarEvents.$inferInsert> = {}) {
  const row = {
    externalId: `ext:${Math.random()}`,
    title: "Design review",
    startsAt: at(90),
    endsAt: at(120),
    day: "2026-11-08",
    attendees: 4,
    attendeeNames: JSON.stringify(["Priya", "Sam", "Alex", "Jo"]),
    ...over,
  };
  t.db.insert(calendarEvents).values(row).run();
  return row;
}

describe("meetingUnprepared", () => {
  it("fires on a meeting with other people in it, soon, with nothing written against it", () => {
    t = makeTestDb();
    event();
    const [p] = meetingUnprepared(t.db, NOW);
    expect(p.title).toBe("Design review starts in an hour");
    expect(p.detail).toBe("Priya, Sam, Alex +1. Nothing written down against it yet.");
    expect(p.sourceRef).toMatch(/^event:\d+$/);
    expect(p.urgency).toBeCloseTo(0.625);
  });

  it("says the minutes while it is still minutes away", () => {
    t = makeTestDb();
    event({ startsAt: at(20) });
    expect(meetingUnprepared(t.db, NOW)[0].title).toBe("Design review starts in 20 minutes");
  });

  it("is quiet about a meeting beyond the prep window, and the window is a setting", () => {
    t = makeTestDb();
    event({ startsAt: at(60 * 6) });
    expect(meetingUnprepared(t.db, NOW)).toHaveLength(0);
    setSetting(t.db, "desk.meetingPrepHours", "8");
    expect(meetingUnprepared(t.db, NOW)).toHaveLength(1);
  });

  it("is quiet about a meeting that has already started", () => {
    t = makeTestDb();
    event({ startsAt: at(-5) });
    expect(meetingUnprepared(t.db, NOW)).toHaveLength(0);
  });

  it("is quiet about a hold with nobody else in it, and about an all-day block", () => {
    t = makeTestDb();
    event({ attendees: 1, title: "Focus" });
    event({ allDay: 1, title: "Conference" });
    expect(meetingUnprepared(t.db, NOW)).toHaveLength(0);
  });

  it("is quiet once something is written against it", () => {
    t = makeTestDb();
    const item = t.db.insert(items).values({ type: "meeting", title: "Design review", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
    event({ itemId: item.id });
    expect(meetingUnprepared(t.db, NOW)).toHaveLength(0);
  });

  it("is quiet about a meeting declined in the calendar or declined by hand", () => {
    t = makeTestDb();
    event({ status: "declined", title: "Declined by calendar" });
    event({ decision: "not-going", title: "Declined by hand" });
    expect(meetingUnprepared(t.db, NOW)).toHaveLength(0);
  });

  /** A standing "I skip this one" covers every occurrence, so the card must not keep asking —
   * unless this particular occurrence was marked as one to attend after all. */
  it("respects a standing decision to skip the series, and this occurrence overriding it", () => {
    t = makeTestDb();
    t.db.insert(meetingSeriesDecisions).values({ seriesId: "s1", decision: "not-going", decidedAt: NOW.toISOString() }).run();
    event({ seriesId: "s1", title: "Skipped standup" });
    expect(meetingUnprepared(t.db, NOW)).toHaveLength(0);

    event({ seriesId: "s1", title: "Going this once", decision: "going" });
    expect(meetingUnprepared(t.db, NOW).map((p) => p.title)).toEqual(["Going this once starts in an hour"]);
  });

  it("falls back to a count when the calendar gave no names", () => {
    t = makeTestDb();
    event({ attendeeNames: "[]", attendees: 9 });
    expect(meetingUnprepared(t.db, NOW)[0].detail).toBe("9 people. Nothing written down against it yet.");
  });

  it("survives attendee names that are not the JSON array they should be", () => {
    t = makeTestDb();
    event({ attendeeNames: "not json", attendees: 3 });
    expect(meetingUnprepared(t.db, NOW)[0].detail).toContain("3 people");
  });

  it("carries everything the commit needs, so accepting re-reads nothing", () => {
    t = makeTestDb();
    event({ organizer: "priya@example.com" });
    expect(meetingUnprepared(t.db, NOW)[0].payload).toMatchObject({
      title: "Design review",
      startsAt: at(90),
      organizer: "priya@example.com",
      attendeeNames: ["Priya", "Sam", "Alex", "Jo"],
    });
  });
});
