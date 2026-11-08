import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { focusRuns, tasks } from "@/db/schema";
import { setSetting } from "@/domain/settings";
import { roundToQuarterHour, taskOverrun } from "./task-overrun";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");

function task(over: Partial<typeof tasks.$inferInsert> = {}) {
  return t.db
    .insert(tasks)
    .values({ title: "Write the migration", estimateMinutes: 60, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over })
    .returning()
    .get();
}

function spend(taskId: number, minutes: number) {
  t.db
    .insert(focusRuns)
    .values({
      taskId,
      startedAt: NOW.toISOString(),
      endedAt: NOW.toISOString(),
      plannedMinutes: minutes,
      actualMinutes: minutes,
      outcome: "completed",
    })
    .run();
}

describe("roundToQuarterHour", () => {
  it("reads in the quarter hours the planner does, and never proposes nothing", () => {
    expect(roundToQuarterHour(97)).toBe(90);
    expect(roundToQuarterHour(98)).toBe(105);
    expect(roundToQuarterHour(3)).toBe(15);
  });
});

describe("taskOverrun", () => {
  it("fires once a task is half again past its estimate", () => {
    t = makeTestDb();
    const task1 = task();
    spend(task1.id, 95);
    const [p] = taskOverrun(t.db, NOW);
    expect(p.title).toBe("Write the migration");
    expect(p.detail).toBe("Estimated 1h, 1h 35m spent so far.");
    expect(p.payload).toMatchObject({ taskId: task1.id, estimateMinutes: 60, spentMinutes: 95, proposedMinutes: 90 });
  });

  it("is quiet while the task is merely over, and the ratio is a setting", () => {
    t = makeTestDb();
    const task1 = task();
    spend(task1.id, 75);
    expect(taskOverrun(t.db, NOW)).toHaveLength(0);
    setSetting(t.db, "desk.overrunRatio", "1.2");
    expect(taskOverrun(t.db, NOW)).toHaveLength(1);
  });

  it("is quiet about a task with no estimate: there is nothing to be wrong", () => {
    t = makeTestDb();
    const task1 = task({ estimateMinutes: null });
    spend(task1.id, 600);
    expect(taskOverrun(t.db, NOW)).toHaveLength(0);
  });

  it("is quiet about a task already done or dropped", () => {
    t = makeTestDb();
    const done = task({ status: "done" });
    spend(done.id, 600);
    const dropped = task({ status: "dropped" });
    spend(dropped.id, 600);
    expect(taskOverrun(t.db, NOW)).toHaveLength(0);
  });

  it("fires again, with fresh evidence, while the task keeps running", () => {
    t = makeTestDb();
    const task1 = task();
    spend(task1.id, 95);
    expect(taskOverrun(t.db, NOW)[0].detail).toContain("1h 35m spent");
    spend(task1.id, 60);
    const [p] = taskOverrun(t.db, NOW);
    expect(p.detail).toContain("2h 35m spent");
    expect(p.payload).toMatchObject({ proposedMinutes: 150 });
  });

  it("grows with the overrun and saturates at three times over", () => {
    t = makeTestDb();
    const near = task();
    spend(near.id, 95);
    const first = taskOverrun(t.db, NOW)[0].urgency;
    t.cleanup();

    t = makeTestDb();
    const far = task();
    spend(far.id, 600);
    expect(taskOverrun(t.db, NOW)[0].urgency).toBe(1);
    expect(first).toBeLessThan(1);
  });
});
