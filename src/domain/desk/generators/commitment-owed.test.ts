import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { people, taskBlocks, tasks } from "@/db/schema";
import { setSetting } from "@/domain/settings";
import { commitmentOwed } from "./commitment-owed";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-10T09:00:00.000Z");

function person(name = "Priya Raman", slug = "priya") {
  return t.db.insert(people).values({ name, slug, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
}

function task(over: Partial<typeof tasks.$inferInsert> = {}) {
  return t.db
    .insert(tasks)
    .values({ title: "Review the migration plan", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over })
    .returning()
    .get();
}

describe("commitmentOwed", () => {
  it("names who is waiting and how long, once the wait is a wait", () => {
    t = makeTestDb();
    const p = person();
    const row = task({ requesterPersonId: p.id, askedOn: "2026-11-06" });
    const [draft] = commitmentOwed(t.db, NOW);
    expect(draft.title).toBe("Review the migration plan");
    expect(draft.detail).toBe("Priya Raman has been waiting 4 days. No time set aside for it.");
    expect(draft.payload).toMatchObject({ taskId: row.id, personName: "Priya Raman", personSlug: "priya", days: 4 });
    expect(draft.sourceRef).toBe(`task:${row.id}`);
  });

  it("says a day rather than 1 days", () => {
    t = makeTestDb();
    const p = person();
    task({ requesterPersonId: p.id, askedOn: "2026-11-09" });
    setSetting(t.db, "desk.owedWaitDays", "1");
    expect(commitmentOwed(t.db, NOW)[0].detail).toBe("Priya Raman has been waiting a day. No time set aside for it.");
  });

  it("stays quiet while the ask is still today's conversation, and the wait is a setting", () => {
    t = makeTestDb();
    const p = person();
    task({ requesterPersonId: p.id, askedOn: "2026-11-09" });
    expect(commitmentOwed(t.db, NOW)).toHaveLength(0);
    setSetting(t.db, "desk.owedWaitDays", "1");
    expect(commitmentOwed(t.db, NOW)).toHaveLength(1);
  });

  it("says nothing about a task nobody asked for, however old", () => {
    t = makeTestDb();
    task({ askedOn: null });
    expect(commitmentOwed(t.db, NOW)).toHaveLength(0);
  });

  it("says nothing once time is set aside for it, on any day", () => {
    t = makeTestDb();
    const p = person();
    const row = task({ requesterPersonId: p.id, askedOn: "2026-11-01" });
    t.db.insert(taskBlocks).values({ taskId: row.id, startsAt: "2026-11-12T14:00", minutes: 30 }).run();
    expect(commitmentOwed(t.db, NOW)).toHaveLength(0);
  });

  it("says nothing about a task already finished or dropped", () => {
    t = makeTestDb();
    const p = person();
    task({ requesterPersonId: p.id, askedOn: "2026-11-01", status: "done" });
    task({ requesterPersonId: p.id, askedOn: "2026-11-01", status: "dropped" });
    expect(commitmentOwed(t.db, NOW)).toHaveLength(0);
  });

  /** The property that separates this kind from `commitment_unbooked`, whose urgency decays. */
  it("gets more urgent the longer somebody waits", () => {
    t = makeTestDb();
    const p = person();
    task({ title: "Two days", requesterPersonId: p.id, askedOn: "2026-11-08" });
    task({ title: "Nine days", requesterPersonId: p.id, askedOn: "2026-11-01" });
    const byTitle = new Map(commitmentOwed(t.db, NOW).map((d) => [d.title, d.urgency]));
    expect(byTitle.get("Nine days")!).toBeGreaterThan(byTitle.get("Two days")!);
    expect(byTitle.get("Nine days")!).toBeLessThanOrEqual(1);
  });

  it("one card per task, however many people are in the table", () => {
    t = makeTestDb();
    const a = person("Priya Raman", "priya");
    person("Sam Okoro", "sam");
    task({ requesterPersonId: a.id, askedOn: "2026-11-01" });
    expect(commitmentOwed(t.db, NOW)).toHaveLength(1);
  });
});
