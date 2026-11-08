import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { calendarEvents, meetingSeriesDecisions } from "@/db/schema";
import { setSetting } from "@/domain/settings";
import { decisionStale } from "./decision-stale";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY_MS).toISOString();
}

function series(seriesId: string, over: Partial<typeof meetingSeriesDecisions.$inferInsert> = {}, title = "Platform sync") {
  t.db.insert(meetingSeriesDecisions).values({ seriesId, decision: "not-going", decidedAt: daysAgo(200), ...over }).run();
  t.db
    .insert(calendarEvents)
    .values({ externalId: `ext:${seriesId}`, title, startsAt: daysAgo(3), endsAt: daysAgo(3), day: "2026-11-05", seriesId })
    .run();
}

describe("decisionStale", () => {
  it("asks about a standing call nothing has confirmed in months", () => {
    t = makeTestDb();
    series("s1");
    const [p] = decisionStale(t.db, NOW);
    expect(p.title).toBe("Still skipping it? — Platform sync");
    expect(p.detail).toBe("You have been skipping this for 200 days, unchecked since.");
    expect(p.sourceRef).toBe("series:s1");
  });

  it("asks in the words of the call that was made", () => {
    t = makeTestDb();
    series("s1", { decision: "going" }, "Weekly review");
    expect(decisionStale(t.db, NOW)[0].title).toBe("Still going? — Weekly review");
    t.cleanup();
    t = makeTestDb();
    series("s2", { decision: "maybe" }, "Roadmap");
    expect(decisionStale(t.db, NOW)[0].title).toBe("Decided yet? — Roadmap");
  });

  it("quotes the reason when one was written down", () => {
    t = makeTestDb();
    series("s1", { note: "  Priya covers it  " });
    expect(decisionStale(t.db, NOW)[0].detail).toBe('You have been skipping this for 200 days: "Priya covers it"');
  });

  it("is quiet about a recent call, and the threshold is a setting", () => {
    t = makeTestDb();
    series("s1", { decidedAt: daysAgo(30) });
    expect(decisionStale(t.db, NOW)).toHaveLength(0);
    setSetting(t.db, "desk.decisionStaleDays", "14");
    expect(decisionStale(t.db, NOW)).toHaveLength(1);
  });

  /** The whole point of the two new columns: a reaffirmation resets the clock, the original
   * decision date does not. */
  it("measures age from the last check, not from when the decision was taken", () => {
    t = makeTestDb();
    series("s1", { decidedAt: daysAgo(400), lastVerified: daysAgo(10) });
    expect(decisionStale(t.db, NOW)).toHaveLength(0);

    t.cleanup();
    t = makeTestDb();
    series("s1", { decidedAt: daysAgo(400), lastVerified: daysAgo(120) });
    expect(decisionStale(t.db, NOW)[0].detail).toContain("120 days");
  });

  it("says nothing about a series the calendar no longer has, rather than naming nothing", () => {
    t = makeTestDb();
    t.db.insert(meetingSeriesDecisions).values({ seriesId: "gone", decision: "not-going", decidedAt: daysAgo(200) }).run();
    expect(decisionStale(t.db, NOW)).toHaveLength(0);
  });

  it("grows in urgency past the threshold and then saturates", () => {
    t = makeTestDb();
    series("s1", { decidedAt: daysAgo(95) });
    const fresh = decisionStale(t.db, NOW)[0].urgency;
    t.cleanup();
    t = makeTestDb();
    series("s1", { decidedAt: daysAgo(400) });
    const ancient = decisionStale(t.db, NOW)[0].urgency;
    t.cleanup();
    t = makeTestDb();
    series("s1", { decidedAt: daysAgo(1200) });
    const ridiculous = decisionStale(t.db, NOW)[0].urgency;

    expect(fresh).toBeLessThan(ancient);
    expect(ancient).toBe(1);
    expect(ridiculous).toBe(1);
  });
});
