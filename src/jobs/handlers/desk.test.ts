import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "@/test/db";
import { calendarEvents, proposals, type Job } from "@/db/schema";
import { createDeskHandler } from "./desk";

let t: TestDb;
afterEach(() => {
  t?.cleanup();
  vi.restoreAllMocks();
});

/** A job row is all the handler is given; the sweep reads its own clock and its own tables. */
const JOB: Job = {
  id: 1,
  type: "desk",
  payload: "{}",
  status: "running",
  attempts: 1,
  error: null,
  itemId: null,
  runAfter: "2026-11-08T09:00:00.000Z",
  createdAt: "2026-11-08T09:00:00.000Z",
  updatedAt: "2026-11-08T09:00:00.000Z",
};

describe("the desk sweep", () => {
  it("does nothing and says nothing on an empty database", async () => {
    t = makeTestDb();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await createDeskHandler({ db: t.db })(JOB);
    expect(t.db.select().from(proposals).all()).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
  });

  it("fills the desk from what the database already holds", async () => {
    t = makeTestDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    // A meeting within the prep window, with other people, nothing written against it.
    t.db
      .insert(calendarEvents)
      .values({
        externalId: "ext:1",
        title: "Design review",
        startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        endsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
        day: "2026-11-08",
        attendees: 3,
        attendeeNames: JSON.stringify(["Priya", "Sam"]),
      })
      .run();

    await createDeskHandler({ db: t.db })(JOB);

    const filed = t.db.select().from(proposals).where(eq(proposals.kind, "meeting_unprepared")).all();
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ state: "open", source: "meeting" });
    expect(filed[0].title).toContain("Design review");
  });

  /** Run twice, fifteen minutes apart, is the normal case — not a special one. */
  it("is idempotent: a second sweep files nothing new", async () => {
    t = makeTestDb();
    vi.spyOn(console, "log").mockImplementation(() => {});
    t.db
      .insert(calendarEvents)
      .values({
        externalId: "ext:1",
        title: "Design review",
        startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        endsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
        day: "2026-11-08",
        attendees: 3,
      })
      .run();

    const handler = createDeskHandler({ db: t.db });
    await handler(JOB);
    await handler(JOB);
    expect(t.db.select().from(proposals).all()).toHaveLength(1);
  });
});
