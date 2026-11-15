import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { people, tasks } from "@/db/schema";
import { addToPlan } from "@/domain/plan";
import { setSetting } from "@/domain/settings";
import { taskOverdue } from "./task-overdue";

let t: TestDb;
afterEach(() => t?.cleanup());

// Local noon, so "today" is the same date whichever side of UTC midnight the suite runs on.
const NOW = new Date("2026-11-10T12:00:00.000Z");
const TODAY = "2026-11-10";

function task(over: Partial<typeof tasks.$inferInsert> = {}) {
  return t.db
    .insert(tasks)
    .values({ title: "Review the migration plan", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over })
    .returning()
    .get();
}

describe("taskOverdue", () => {
  it("names the date and how long ago it was", () => {
    t = makeTestDb();
    const row = task({ dueDate: "2026-11-03" });
    const [draft] = taskOverdue(t.db, NOW);
    expect(draft.title).toBe("Review the migration plan");
    expect(draft.detail).toBe("Due 2026-11-03, 7 days ago. Nothing set aside for it today.");
    expect(draft.payload).toMatchObject({ taskId: row.id, dueDate: "2026-11-03", days: 7 });
    expect(draft.sourceRef).toBe(`task:${row.id}`);
  });

  it("says a day rather than 1 days", () => {
    t = makeTestDb();
    task({ dueDate: "2026-11-09" });
    expect(taskOverdue(t.db, NOW)[0].detail).toContain("a day ago");
  });

  it("says nothing about a task due today or later", () => {
    t = makeTestDb();
    task({ dueDate: TODAY });
    task({ dueDate: "2026-11-20" });
    expect(taskOverdue(t.db, NOW)).toHaveLength(0);
  });

  it("takes the grace period from a setting", () => {
    t = makeTestDb();
    task({ dueDate: "2026-11-09" });
    setSetting(t.db, "desk.overdueGraceDays", "5");
    expect(taskOverdue(t.db, NOW)).toHaveLength(0);
  });

  it("stays quiet about a task already on today's plan", () => {
    // Having chosen to do it today IS the answer this card asks for. Showing it anyway would get
    // the card dismissed, which teaches the ranker the kind is unwanted when it was only late.
    t = makeTestDb();
    const row = task({ dueDate: "2026-11-03" });
    addToPlan(t.db, TODAY, row.id);
    expect(taskOverdue(t.db, NOW)).toHaveLength(0);
  });

  it("still speaks up when the only plan entry is a past day", () => {
    // Planned for yesterday and not done is precisely the case worth a card -- the anti-join has
    // to be dated, not merely "is on some plan".
    t = makeTestDb();
    const row = task({ dueDate: "2026-11-03" });
    addToPlan(t.db, "2026-11-09", row.id);
    expect(taskOverdue(t.db, NOW)).toHaveLength(1);
  });

  it("ignores what is finished, dropped, closed or somebody else's", () => {
    t = makeTestDb();
    const other = t.db.insert(people).values({ name: "Priya Raman", slug: "priya", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
    task({ dueDate: "2026-11-01", completedAt: "2026-11-02T10:00:00.000Z" });
    task({ dueDate: "2026-11-01", droppedAt: "2026-11-02T10:00:00.000Z" });
    task({ dueDate: "2026-11-01", status: "done" });
    task({ dueDate: "2026-11-01", ownerPersonId: other.id });
    expect(taskOverdue(t.db, NOW)).toHaveLength(0);
  });

  it("has no opinion about a task with no due date", () => {
    // Most tasks have none, and inventing a deadline for them would turn the whole backlog into
    // a desk queue.
    t = makeTestDb();
    task({ dueDate: null });
    expect(taskOverdue(t.db, NOW)).toHaveLength(0);
  });

  it("gets more urgent the longer the date has been past, and matches commitment_owed's shape", () => {
    t = makeTestDb();
    task({ dueDate: "2026-11-09", title: "yesterday" });
    const justLate = taskOverdue(t.db, NOW)[0].urgency;

    t.cleanup();
    t = makeTestDb();
    task({ dueDate: "2026-10-20", title: "three weeks" });
    const longLate = taskOverdue(t.db, NOW)[0].urgency;

    expect(justLate).toBeCloseTo(0.3, 5);
    expect(longLate).toBe(1);
    expect(longLate).toBeGreaterThan(justLate);
  });
});
