import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { calendarEvents, proposals, tasks } from "@/db/schema";
import { recordHelperSeen } from "@/domain/activity/helper-state";
import { ingestObservations } from "@/domain/observations";
import {
  calendarHasNoMeetings,
  captureBlocked,
  collectInsights,
  deskNeverAnswered,
  everythingFlowing,
  nothingEverCompleted,
  slackIsAllBroadcasts,
} from "./generators";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-15T12:00:00.000Z");
const ISO = NOW.toISOString();

function helper(accessibility: boolean) {
  recordHelperSeen(t.db, ISO, { version: "1.0.0", permissions: { accessibility, calendar: true, automation: {} } });
}

function task(over: Partial<typeof tasks.$inferInsert> = {}) {
  return t.db.insert(tasks).values({ title: "A task", createdAt: ISO, updatedAt: ISO, ...over }).returning().get();
}

function event(over: Partial<typeof calendarEvents.$inferInsert> = {}) {
  return t.db
    .insert(calendarEvents)
    .values({
      externalId: `e${Math.random()}`,
      title: "An entry",
      startsAt: "2026-11-10T09:00:00.000Z",
      endsAt: "2026-11-10T10:00:00.000Z",
      day: "2026-11-10",
      ...over,
    })
    .returning()
    .get();
}

function slack(text: string, externalId = `C1/${Math.random()}`) {
  ingestObservations(t.db, [{ source: "slack", externalId, at: "2026-11-01T09:00:00.000Z", kind: "mention", text }], NOW);
}

describe("captureBlocked", () => {
  it("says so when the helper has never reported", () => {
    t = makeTestDb();
    const [out] = captureBlocked(t.db, NOW);
    expect(out.severity).toBe("blocked");
    expect(out.headline).toContain("never reported");
  });

  it("names the trap: an update voids a grant while the switch still looks on", () => {
    t = makeTestDb();
    helper(false);
    const [out] = captureBlocked(t.db, NOW);
    expect(out.severity).toBe("blocked");
    expect(out.detail).toContain("voided");
  });

  it("stays quiet once it is granted", () => {
    t = makeTestDb();
    helper(true);
    expect(captureBlocked(t.db, NOW)).toHaveLength(0);
  });
});

describe("calendarHasNoMeetings", () => {
  it("calls out a calendar that is all holidays", () => {
    // The real case: seventeen entries, every one an all-day public holiday, while meeting prep
    // and auto-record had been shipped and had never once fired.
    t = makeTestDb();
    for (let i = 0; i < 3; i++) event({ allDay: 1, attendees: 0, calendarTitle: "Holidays" });
    const [out] = calendarHasNoMeetings(t.db, NOW);
    expect(out.severity).toBe("blocked");
    expect(out.headline).toContain("All 3 calendar entries");
  });

  it("stays quiet when one real meeting exists", () => {
    t = makeTestDb();
    event({ allDay: 1, attendees: 0 });
    event({ allDay: 0, attendees: 3 });
    expect(calendarHasNoMeetings(t.db, NOW)).toHaveLength(0);
  });

  it("says nothing at all about an empty calendar", () => {
    // No events is "no calendar connected", which is a different claim and not this one's to make.
    t = makeTestDb();
    expect(calendarHasNoMeetings(t.db, NOW)).toHaveLength(0);
  });

  it("ignores entries older than a month, so last quarter cannot speak for today", () => {
    t = makeTestDb();
    event({ allDay: 1, attendees: 0, day: "2026-01-01" });
    expect(calendarHasNoMeetings(t.db, NOW)).toHaveLength(0);
  });
});

describe("nothingEverCompleted", () => {
  it("notices a backlog with no completions at all", () => {
    t = makeTestDb();
    for (let i = 0; i < 25; i++) task({ status: "open" });
    const [out] = nothingEverCompleted(t.db, NOW);
    expect(out.headline).toContain("25 open tasks");
  });

  it("stays quiet once anything has been finished", () => {
    t = makeTestDb();
    for (let i = 0; i < 25; i++) task({ status: "open" });
    task({ status: "done", completedAt: ISO });
    expect(nothingEverCompleted(t.db, NOW)).toHaveLength(0);
  });

  it("stays quiet about a small backlog, which proves nothing either way", () => {
    t = makeTestDb();
    for (let i = 0; i < 5; i++) task({ status: "open" });
    expect(nothingEverCompleted(t.db, NOW)).toHaveLength(0);
  });
});

describe("slackIsAllBroadcasts", () => {
  it("explains a quiet desk when every message is an announcement", () => {
    t = makeTestDb();
    slack("@channel New job posted");
    slack("@here standup moved");
    const [out] = slackIsAllBroadcasts(t.db, NOW);
    expect(out.headline).toContain("All 2 Slack messages");
    expect(out.detail).toContain("deliberate");
  });

  it("stays quiet as soon as one message is personal", () => {
    t = makeTestDb();
    slack("@channel New job posted");
    slack("can you confirm the Q4 numbers?");
    expect(slackIsAllBroadcasts(t.db, NOW)).toHaveLength(0);
  });

  it("says nothing before Slack has been read at all", () => {
    t = makeTestDb();
    expect(slackIsAllBroadcasts(t.db, NOW)).toHaveLength(0);
  });
});

describe("deskNeverAnswered", () => {
  function proposal(state: "open" | "accepted", decidedAt: string | null = null) {
    t.db
      .insert(proposals)
      .values({ kind: "task_overdue", source: "task", sourceRef: `x${Math.random()}`, title: "A card", rank: 0.5, state, decidedAt, createdAt: ISO })
      .run();
  }

  it("reports a desk that has never been cleared", () => {
    t = makeTestDb();
    proposal("open");
    proposal("open");
    const [out] = deskNeverAnswered(t.db, NOW);
    expect(out.headline).toContain("2 decisions are waiting");
  });

  it("stays quiet once anything has been answered", () => {
    t = makeTestDb();
    proposal("open");
    proposal("accepted", ISO);
    expect(deskNeverAnswered(t.db, NOW)).toHaveLength(0);
  });

  it("stays quiet when the desk is clear", () => {
    t = makeTestDb();
    expect(deskNeverAnswered(t.db, NOW)).toHaveLength(0);
  });
});

describe("everythingFlowing", () => {
  it("says so when capture is granted and Slack is arriving", () => {
    t = makeTestDb();
    helper(true);
    slack("can you confirm the Q4 numbers?");
    const [out] = everythingFlowing(t.db, NOW);
    expect(out.severity).toBe("good");
  });

  it("claims nothing while the permission is missing", () => {
    t = makeTestDb();
    helper(false);
    slack("can you confirm the Q4 numbers?");
    expect(everythingFlowing(t.db, NOW)).toHaveLength(0);
  });
});

describe("collectInsights", () => {
  it("puts what is blocked above what is merely notable", () => {
    t = makeTestDb();
    helper(false);
    for (let i = 0; i < 25; i++) task({ status: "open" });
    const out = collectInsights(t.db, NOW);
    expect(out.map((i) => i.severity)).toEqual([...out.map((i) => i.severity)].sort());
    expect(out[0].severity).toBe("blocked");
  });

  it("survives one generator throwing, because a blank page is worse than a missing line", () => {
    t = makeTestDb();
    helper(false);
    const broken = { select: () => { throw new Error("boom"); } } as never;
    const messages: string[] = [];
    expect(() => collectInsights(broken, NOW, (m) => messages.push(m))).not.toThrow();
    expect(messages.length).toBeGreaterThan(0);
  });

  it("says nothing about a brand new install with no data and no helper yet", () => {
    // Except the one thing that is true of it: nothing is capturing.
    t = makeTestDb();
    expect(collectInsights(t.db, NOW).map((i) => i.id)).toEqual(["capture:helper-silent"]);
  });
});
