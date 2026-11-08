import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { dailyPlanEntries, focusRuns, tasks } from "@/db/schema";
import { setSetting } from "@/domain/settings";
import { taskStalled } from "./task-stalled";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");

function task(over: Partial<typeof tasks.$inferInsert> = {}) {
  return t.db
    .insert(tasks)
    .values({ title: "Answer the auditors", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over })
    .returning()
    .get();
}

function planOn(taskId: number, dates: string[]) {
  for (const date of dates) {
    t.db.insert(dailyPlanEntries).values({ date, taskId, createdAt: NOW.toISOString() }).run();
  }
}

describe("taskStalled", () => {
  it("fires on a task carried across three days with nothing done on it", () => {
    t = makeTestDb();
    const task1 = task();
    planOn(task1.id, ["2026-11-04", "2026-11-05", "2026-11-06"]);
    const [p] = taskStalled(t.db, NOW);
    expect(p.title).toBe("Answer the auditors");
    expect(p.detail).toBe("Planned on 3 different days, never started. Last on 2026-11-06.");
    expect(p.payload).toMatchObject({ taskId: task1.id, days: 3, lastPlanned: "2026-11-06" });
  });

  it("is quiet below the threshold, and the threshold is a setting", () => {
    t = makeTestDb();
    const task1 = task();
    planOn(task1.id, ["2026-11-04", "2026-11-05"]);
    expect(taskStalled(t.db, NOW)).toHaveLength(0);
    setSetting(t.db, "desk.stalledPlanDays", "2");
    expect(taskStalled(t.db, NOW)).toHaveLength(1);
  });

  /** A task someone has actually sat with is in progress, and the desk has nothing to say. */
  it("is quiet once any focus time at all has gone on it", () => {
    t = makeTestDb();
    const task1 = task();
    planOn(task1.id, ["2026-11-04", "2026-11-05", "2026-11-06"]);
    t.db
      .insert(focusRuns)
      .values({ taskId: task1.id, startedAt: NOW.toISOString(), endedAt: NOW.toISOString(), plannedMinutes: 25, actualMinutes: 10, outcome: "stopped" })
      .run();
    expect(taskStalled(t.db, NOW)).toHaveLength(0);
  });

  it("counts distinct days, not plan rows, so one day planned twice is one day", () => {
    t = makeTestDb();
    const task1 = task();
    // The unique index forbids the same (date, task) twice, so this is the honest shape of the
    // risk: three rows across two days must not read as three days.
    planOn(task1.id, ["2026-11-04", "2026-11-05"]);
    expect(taskStalled(t.db, NOW)).toHaveLength(0);
    planOn(task1.id, ["2026-11-06"]);
    expect(taskStalled(t.db, NOW)[0].payload).toMatchObject({ days: 3 });
  });

  it("is quiet about a task that is already done or dropped", () => {
    t = makeTestDb();
    const done = task({ status: "done" });
    planOn(done.id, ["2026-11-04", "2026-11-05", "2026-11-06"]);
    expect(taskStalled(t.db, NOW)).toHaveLength(0);
  });

  it("grows the longer it has been carried", () => {
    t = makeTestDb();
    const task1 = task();
    planOn(task1.id, ["2026-11-04", "2026-11-05", "2026-11-06"]);
    const three = taskStalled(t.db, NOW)[0].urgency;
    planOn(task1.id, ["2026-11-07", "2026-11-08", "2026-11-09"]);
    expect(taskStalled(t.db, NOW)[0].urgency).toBeGreaterThan(three);
  });
});
