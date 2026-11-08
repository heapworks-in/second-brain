import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "@/test/db";
import { calendarEvents, items, meetingSeriesContainers } from "@/db/schema";
import { createItem } from "@/domain/items";
import { createContainer } from "@/domain/containers";
import {
  meetingTimeByContainer,
  assignMeetingContainer,
  containerMeetingRollup,
  effectiveContainerId,
  seriesContainers,
  unattributedMeetings,
} from "./attribution";
import { MeetingError } from "./errors";

describe("effectiveContainerId", () => {
  it("prefers the occurrence's own assignment", () => {
    expect(effectiveContainerId({ containerId: 7, seriesId: "s" }, 3)).toBe(7);
  });

  it("falls back to the series assignment", () => {
    expect(effectiveContainerId({ containerId: null, seriesId: "s" }, 3)).toBe(3);
  });

  it("is unattributed when neither says anything", () => {
    expect(effectiveContainerId({ containerId: null, seriesId: null }, null)).toBeNull();
  });
});

describe("meeting attribution", () => {
  let t: TestDb;
  let project: number;
  let area: number;
  let resource: number;

  const RANGE = { from: "2026-09-01", to: "2026-10-01" };

  function makeContainer(kind: "project" | "area" | "resource", name: string): number {
    return createContainer(t.db, { kind, name }).id;
  }

  function makeMeeting(over: Partial<typeof calendarEvents.$inferInsert> = {}): number {
    return t.db
      .insert(calendarEvents)
      .values({
        externalId: `ext-${Math.random()}`,
        title: "Standup",
        startsAt: "2026-09-10T09:00:00.000Z",
        endsAt: "2026-09-10T09:30:00.000Z",
        day: "2026-09-10",
        attendees: 0,
        hasCallLink: 0,
        source: "feed",
        ...over,
      })
      .returning({ id: calendarEvents.id })
      .get().id;
  }

  beforeEach(() => {
    t = makeTestDb();
    project = makeContainer("project", "Payments");
    area = makeContainer("area", "Hiring");
    resource = makeContainer("resource", "Reading");
  });
  afterEach(() => t.cleanup());

  it("assigns a single occurrence without touching its series", () => {
    const id = makeMeeting({ seriesId: "series-a" });
    assignMeetingContainer(t.db, id, project, "occurrence");
    const row = t.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get();
    expect(row?.containerId).toBe(project);
    expect(t.db.select().from(meetingSeriesContainers).all()).toHaveLength(0);
  });

  it("assigns a whole series, covering occurrences it was not issued from", () => {
    const first = makeMeeting({ seriesId: "series-a", day: "2026-09-10" });
    const second = makeMeeting({ seriesId: "series-a", day: "2026-09-17", startsAt: "2026-09-17T09:00:00.000Z", endsAt: "2026-09-17T09:30:00.000Z" });
    assignMeetingContainer(t.db, first, project, "series");
    const map = seriesContainers(t.db, ["series-a"]);
    const row = t.db.select().from(calendarEvents).where(eq(calendarEvents.id, second)).get();
    expect(effectiveContainerId(row!, map.get("series-a") ?? null)).toBe(project);
  });

  // A series write that left the issuing row's own override in place would look like it did
  // nothing, because the override still wins when that row resolves.
  it("clears the issuing occurrence's override so the series answer governs it", () => {
    const id = makeMeeting({ seriesId: "series-a" });
    assignMeetingContainer(t.db, id, area, "occurrence");
    assignMeetingContainer(t.db, id, project, "series");
    const row = t.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get();
    expect(row?.containerId).toBeNull();
    expect(effectiveContainerId(row!, seriesContainers(t.db, ["series-a"]).get("series-a") ?? null)).toBe(project);
  });

  it("lets one occurrence differ from its series", () => {
    const first = makeMeeting({ seriesId: "series-a" });
    const odd = makeMeeting({ seriesId: "series-a", day: "2026-09-17", startsAt: "2026-09-17T09:00:00.000Z", endsAt: "2026-09-17T09:30:00.000Z" });
    assignMeetingContainer(t.db, first, project, "series");
    assignMeetingContainer(t.db, odd, area, "occurrence");
    const map = seriesContainers(t.db, ["series-a"]);
    const row = t.db.select().from(calendarEvents).where(eq(calendarEvents.id, odd)).get();
    expect(effectiveContainerId(row!, map.get("series-a") ?? null)).toBe(area);
  });

  it("clears an assignment at either scope", () => {
    const id = makeMeeting({ seriesId: "series-a" });
    assignMeetingContainer(t.db, id, project, "series");
    assignMeetingContainer(t.db, id, null, "series");
    expect(t.db.select().from(meetingSeriesContainers).all()).toHaveLength(0);

    assignMeetingContainer(t.db, id, project, "occurrence");
    assignMeetingContainer(t.db, id, null, "occurrence");
    expect(t.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()?.containerId).toBeNull();
  });

  it("refuses a series write on a meeting that has no series", () => {
    const id = makeMeeting({ seriesId: null });
    expect(() => assignMeetingContainer(t.db, id, project, "series")).toThrow(MeetingError);
  });

  it("refuses containers that are not a project or an area", () => {
    const id = makeMeeting();
    expect(() => assignMeetingContainer(t.db, id, resource, "occurrence")).toThrow(MeetingError);
  });

  it("refuses an unknown meeting or container", () => {
    const id = makeMeeting();
    expect(() => assignMeetingContainer(t.db, 9999, project, "occurrence")).toThrow(MeetingError);
    expect(() => assignMeetingContainer(t.db, id, 9999, "occurrence")).toThrow(MeetingError);
  });

  // The whole point of the rollup: "what has this project cost me" must include occurrences that
  // happened before anyone got around to labelling the series.
  it("counts occurrences that happened before the series was assigned", () => {
    const past = makeMeeting({ seriesId: "series-a", day: "2026-09-03", startsAt: "2026-09-03T09:00:00.000Z", endsAt: "2026-09-03T10:00:00.000Z" });
    makeMeeting({ seriesId: "series-a", day: "2026-09-10" });
    assignMeetingContainer(t.db, past, project, "series", new Date("2026-09-20T00:00:00.000Z"));
    const rollup = containerMeetingRollup(t.db, project, RANGE);
    expect(rollup.meetings).toBe(2);
    expect(rollup.minutes).toBe(90);
  });

  it("totals time and breaks it down by series, heaviest first", () => {
    const a = makeMeeting({ seriesId: "big", title: "Weekly review", day: "2026-09-10", startsAt: "2026-09-10T09:00:00.000Z", endsAt: "2026-09-10T11:00:00.000Z" });
    makeMeeting({ seriesId: "big", title: "Weekly review", day: "2026-09-17", startsAt: "2026-09-17T09:00:00.000Z", endsAt: "2026-09-17T11:00:00.000Z" });
    const b = makeMeeting({ seriesId: "small", title: "Standup", day: "2026-09-11", startsAt: "2026-09-11T09:00:00.000Z", endsAt: "2026-09-11T09:15:00.000Z" });
    assignMeetingContainer(t.db, a, project, "series");
    assignMeetingContainer(t.db, b, project, "series");

    const rollup = containerMeetingRollup(t.db, project, RANGE);
    expect(rollup.minutes).toBe(255);
    expect(rollup.series.map((s) => s.title)).toEqual(["Weekly review", "Standup"]);
    expect(rollup.series[0]).toMatchObject({ occurrences: 2, minutes: 240 });
  });

  it("leaves all-day entries out of the total", () => {
    const id = makeMeeting({ allDay: 1, title: "Public holiday", startsAt: "2026-09-10T00:00:00.000Z", endsAt: "2026-09-11T00:00:00.000Z" });
    assignMeetingContainer(t.db, id, project, "occurrence");
    expect(containerMeetingRollup(t.db, project, RANGE).minutes).toBe(0);
  });

  it("counts nothing for another container", () => {
    const id = makeMeeting();
    assignMeetingContainer(t.db, id, project, "occurrence");
    expect(containerMeetingRollup(t.db, area, RANGE).meetings).toBe(0);
  });

  it("ignores meetings outside the range", () => {
    const id = makeMeeting({ day: "2026-08-10", startsAt: "2026-08-10T09:00:00.000Z", endsAt: "2026-08-10T10:00:00.000Z" });
    assignMeetingContainer(t.db, id, project, "occurrence");
    expect(containerMeetingRollup(t.db, project, RANGE).meetings).toBe(0);
  });

  it("lists what nothing claims, and stops listing it once claimed", () => {
    const id = makeMeeting({ title: "Mystery sync", seriesId: "series-a" });
    expect(unattributedMeetings(t.db, RANGE).map((m) => m.title)).toEqual(["Mystery sync"]);
    assignMeetingContainer(t.db, id, project, "series");
    expect(unattributedMeetings(t.db, RANGE)).toEqual([]);
  });
});

describe("captured-item fallback", () => {
  let t: TestDb;
  let project: number;
  let area: number;
  const RANGE = { from: "2026-09-01", to: "2026-10-01" };

  beforeEach(() => {
    t = makeTestDb();
    project = createContainer(t.db, { kind: "project", name: "Payments" }).id;
    area = createContainer(t.db, { kind: "area", name: "Hiring" }).id;
  });
  afterEach(() => t.cleanup());

  function meetingWithFiledItem(containerId: number | null): number {
    const item = createItem(t.db, { type: "note", title: "Meeting note" });
    if (containerId !== null) {
      t.db.update(items).set({ containerId }).where(eq(items.id, item.id)).run();
    }
    return t.db
      .insert(calendarEvents)
      .values({
        externalId: `ext-${Math.random()}`,
        title: "Filed meeting",
        startsAt: "2026-09-10T09:00:00.000Z",
        endsAt: "2026-09-10T10:00:00.000Z",
        day: "2026-09-10",
        attendees: 0,
        hasCallLink: 0,
        source: "feed",
        itemId: item.id,
      })
      .returning({ id: calendarEvents.id })
      .get().id;
  }

  it("falls back to where the captured item was filed", () => {
    meetingWithFiledItem(project);
    expect(containerMeetingRollup(t.db, project, RANGE).meetings).toBe(1);
    expect(unattributedMeetings(t.db, RANGE)).toEqual([]);
  });

  it("is overridden by an explicit assignment on the meeting", () => {
    const id = meetingWithFiledItem(project);
    assignMeetingContainer(t.db, id, area, "occurrence");
    expect(containerMeetingRollup(t.db, area, RANGE).meetings).toBe(1);
    expect(containerMeetingRollup(t.db, project, RANGE).meetings).toBe(0);
  });

  it("stays unattributed when the item is filed nowhere", () => {
    meetingWithFiledItem(null);
    expect(unattributedMeetings(t.db, RANGE).map((m) => m.title)).toEqual(["Filed meeting"]);
  });

  it("orders occurrence over series over item", () => {
    expect(effectiveContainerId({ containerId: 1, seriesId: "s" }, 2, 3)).toBe(1);
    expect(effectiveContainerId({ containerId: null, seriesId: "s" }, 2, 3)).toBe(2);
    expect(effectiveContainerId({ containerId: null, seriesId: null }, null, 3)).toBe(3);
  });
});

/**
 * Where the time actually goes. The per-container rollup has existed, tested, since the
 * attribution work; the ranking across containers is what answers the question somebody asks.
 */
describe("meetingTimeByContainer", () => {
  let t: TestDb;
  const RANGE = { from: "2026-09-01", to: "2026-10-01" };

  function container(kind: "project" | "area", name: string): number {
    return createContainer(t.db, { kind, name }).id;
  }

  function meeting(over: Partial<typeof calendarEvents.$inferInsert> = {}): number {
    return t.db
      .insert(calendarEvents)
      .values({
        externalId: `ext-${Math.random()}`,
        title: "Standup",
        startsAt: "2026-09-10T09:00:00.000Z",
        endsAt: "2026-09-10T09:30:00.000Z",
        day: "2026-09-10",
        attendees: 0,
        hasCallLink: 0,
        source: "eventkit",
        ...over,
      })
      .returning({ id: calendarEvents.id })
      .get().id;
  }

  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("ranks the heaviest claim first, with its meeting count", () => {
    const payments = container("project", "Payments");
    const admin = container("area", "Admin");
    meeting({ containerId: payments, startsAt: "2026-09-10T09:00:00.000Z", endsAt: "2026-09-10T10:00:00.000Z" });
    meeting({ containerId: payments, startsAt: "2026-09-11T09:00:00.000Z", endsAt: "2026-09-11T09:30:00.000Z" });
    meeting({ containerId: admin, startsAt: "2026-09-12T09:00:00.000Z", endsAt: "2026-09-12T09:15:00.000Z" });

    expect(meetingTimeByContainer(t.db, RANGE)).toEqual([
      { containerId: payments, meetings: 2, minutes: 90 },
      { containerId: admin, meetings: 1, minutes: 15 },
    ]);
  });

  /** A series labelled once carries every occurrence, which is the whole reason that is cheap. */
  it("counts occurrences that inherit their container from the series", () => {
    const payments = container("project", "Payments");
    t.db.insert(meetingSeriesContainers).values({ seriesId: "eventkit:weekly", containerId: payments, assignedAt: "2026-09-01T00:00:00.000Z" }).run();
    meeting({ seriesId: "eventkit:weekly", startsAt: "2026-09-10T09:00:00.000Z", endsAt: "2026-09-10T09:30:00.000Z" });
    meeting({ seriesId: "eventkit:weekly", startsAt: "2026-09-17T09:00:00.000Z", endsAt: "2026-09-17T09:30:00.000Z" });

    expect(meetingTimeByContainer(t.db, RANGE)).toEqual([{ containerId: payments, meetings: 2, minutes: 60 }]);
  });

  it("leaves out meetings nothing claims, rather than bucketing them somewhere", () => {
    const payments = container("project", "Payments");
    meeting({ containerId: payments });
    meeting({});
    const out = meetingTimeByContainer(t.db, RANGE);
    expect(out).toHaveLength(1);
    expect(out[0].containerId).toBe(payments);
  });

  /** An out-of-office block or a holiday spans a whole day and would dwarf every real meeting. */
  it("leaves all-day entries out of the total", () => {
    const admin = container("area", "Admin");
    meeting({ containerId: admin, allDay: 1, startsAt: "2026-09-14T00:00:00.000Z", endsAt: "2026-09-15T00:00:00.000Z" });
    meeting({ containerId: admin, startsAt: "2026-09-14T09:00:00.000Z", endsAt: "2026-09-14T09:30:00.000Z" });

    expect(meetingTimeByContainer(t.db, RANGE)).toEqual([{ containerId: admin, meetings: 1, minutes: 30 }]);
  });

  it("respects the range, exclusive of `to`", () => {
    const payments = container("project", "Payments");
    meeting({ containerId: payments, day: "2026-08-31", startsAt: "2026-08-31T09:00:00.000Z", endsAt: "2026-08-31T10:00:00.000Z" });
    meeting({ containerId: payments, day: "2026-10-01", startsAt: "2026-10-01T09:00:00.000Z", endsAt: "2026-10-01T10:00:00.000Z" });
    expect(meetingTimeByContainer(t.db, RANGE)).toEqual([]);
  });

  it("is empty when nothing is attributed at all", () => {
    meeting({});
    expect(meetingTimeByContainer(t.db, RANGE)).toEqual([]);
  });
});
