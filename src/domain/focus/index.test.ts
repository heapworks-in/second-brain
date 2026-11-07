import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { focusRuns } from "@/db/schema";
import { createTask, completeTask } from "@/domain/tasks";
import { createContainer } from "@/domain/containers";
import { addBlock } from "@/domain/blocks";
import { ingestHeartbeat } from "@/domain/activity";
import {
  startFocus,
  finishFocus,
  runningFocus,
  focusMinutesByTask,
  focusMinutesByBlock,
  focusSummary,
  completedToday,
  focusWhere,
  getFocusSettings,
  estimateActualPairs,
  likeThisMinutesByTask,
  similarActualMinutes,
  LIKE_THIS_MIN_MATCHES,
  FocusError,
  ABANDON_UNDER,
  STALE_AFTER,
} from "./index";

// Built from local Date components, never from a UTC string: the domain buckets by *local* day
// (`localDay`), so an instant built from a UTC literal names a different local day depending on
// the machine's own timezone, and the same test would fail west of about UTC-10. Constructed this
// way, `at("09:00")` is 09:00 local wall-clock time on 2026-09-24 in any timezone Node runs in,
// so its local day is always the literal "2026-09-24" below, everywhere.
const at = (hhmm: string): Date => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 8, 24, h, m, 0, 0);
};
const atNextDay = (hhmm: string): Date => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2026, 8, 25, h, m, 0, 0);
};

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => t.cleanup());

describe("a focus run", () => {
  it("books its minutes against the task when the clock runs out", () => {
    const task = createTask(t.db, { title: "Draft the brief" });
    const run = startFocus(t.db, { taskId: task.id, minutes: 45 }, at("09:00"));
    const done = finishFocus(t.db, run.id, "completed", at("09:45"));
    expect(done).toMatchObject({ outcome: "completed", actualMinutes: 45 });
    expect(focusMinutesByTask(t.db, [task.id]).get(task.id)).toBe(45);
  });

  it("keeps the minutes actually run when it is stopped early", () => {
    const task = createTask(t.db, { title: "Draft the brief" });
    const run = startFocus(t.db, { taskId: task.id, minutes: 45 }, at("09:00"));
    expect(finishFocus(t.db, run.id, "stopped", at("09:20"))).toMatchObject({ outcome: "stopped", actualMinutes: 20 });
  });

  it("abandons a run ended inside the first two minutes, whatever it is called, and books nothing", () => {
    const task = createTask(t.db, { title: "Draft the brief" });
    const run = startFocus(t.db, { taskId: task.id, minutes: 45 }, at("09:00"));
    const done = finishFocus(t.db, run.id, "stopped", at("09:01"));
    expect(done).toMatchObject({ outcome: "abandoned", actualMinutes: 0 });
    expect(focusMinutesByTask(t.db, [task.id]).get(task.id) ?? 0).toBe(0);
    expect(ABANDON_UNDER).toBe(2);
  });

  it("starting a second run stops the first", () => {
    const a = createTask(t.db, { title: "A" });
    const b = createTask(t.db, { title: "B" });
    const first = startFocus(t.db, { taskId: a.id, minutes: 45 }, at("09:00"));
    startFocus(t.db, { taskId: b.id, minutes: 25 }, at("09:30"));
    const rows = t.db.select().from(focusRuns).all();
    const stopped = rows.find((r) => r.id === first.id)!;
    expect(stopped).toMatchObject({ outcome: "stopped", actualMinutes: 30 });
    expect(runningFocus(t.db, at("09:35"))!.taskId).toBe(b.id);
  });

  it("starts a second run even when the clock has stepped backwards, clamping the incumbent's close rather than failing", () => {
    const a = createTask(t.db, { title: "A" });
    const b = createTask(t.db, { title: "B" });
    startFocus(t.db, { taskId: a.id, minutes: 45 }, at("10:00"));
    // An NTP step backwards: the new start's `now` predates the incumbent's own start.
    const second = startFocus(t.db, { taskId: b.id, minutes: 25 }, at("09:00"));
    expect(second.taskId).toBe(b.id);
    expect(runningFocus(t.db, at("09:05"))!.taskId).toBe(b.id);
    const rows = t.db.select().from(focusRuns).all();
    const stopped = rows.find((r) => r.taskId === a.id)!;
    // Clamped to no earlier than its own start: zero elapsed, so it reads as abandoned.
    expect(stopped).toMatchObject({ outcome: "abandoned", actualMinutes: 0 });
  });

  it("is still live inside the grace period, and closed at its planned end past it", () => {
    const task = createTask(t.db, { title: "Draft the brief" });
    startFocus(t.db, { taskId: task.id, minutes: 45 }, at("09:00"));
    expect(runningFocus(t.db, at("10:00"))).not.toBeNull(); // 15 min past, inside STALE_AFTER
    const gone = runningFocus(t.db, at("11:00")); // 75 min past, beyond it
    expect(gone).toBeNull();
    expect(focusMinutesByTask(t.db, [task.id]).get(task.id)).toBe(45); // closed at the end it was meant to have
    expect(STALE_AFTER).toBe(30);
  });

  it("refuses a run on a task that is not there", () => {
    expect(() => startFocus(t.db, { taskId: 9999, minutes: 25 }, at("09:00"))).toThrow(/task/i);
  });

  it("refuses a run outside 5 to 480 minutes", () => {
    const task = createTask(t.db, { title: "Draft the brief" });
    expect(() => startFocus(t.db, { taskId: task.id, minutes: 4 }, at("09:00"))).toThrow();
    expect(() => startFocus(t.db, { taskId: task.id, minutes: 481 }, at("09:00"))).toThrow();
  });

  it("uses the configured default length when none is given", () => {
    const task = createTask(t.db, { title: "Draft the brief" });
    expect(getFocusSettings(t.db).defaultMinutes).toBe(25);
    const run = startFocus(t.db, { taskId: task.id }, at("09:00"));
    expect(run.plannedMinutes).toBe(25);
  });

  it("books its minutes against the session it was a box for, so the promise can be read against the cost", () => {
    const task = createTask(t.db, { title: "Migrate" });
    const box = addBlock(t.db, { taskId: task.id, startsAt: "2026-09-24T09:00:00", minutes: 45 });
    const other = addBlock(t.db, { taskId: task.id, startsAt: "2026-09-24T14:00:00", minutes: 45 });

    // A box run to the end costs exactly what it promised.
    finishFocus(t.db, startFocus(t.db, { taskId: task.id, blockId: box.id }, at("09:00")).id, "completed", at("09:45"));
    expect(focusMinutesByBlock(t.db, [box.id, other.id]).get(box.id)).toBe(45);
    // A session nothing ran against is simply absent, never a zero.
    expect(focusMinutesByBlock(t.db, [box.id, other.id]).has(other.id)).toBe(false);

    // A second run against the same box adds to it: that is how an overrun becomes visible.
    finishFocus(t.db, startFocus(t.db, { taskId: task.id, blockId: box.id }, at("10:00")).id, "stopped", at("10:20"));
    expect(focusMinutesByBlock(t.db, [box.id]).get(box.id)).toBe(65);

    // An abandoned run books nothing here either.
    finishFocus(t.db, startFocus(t.db, { taskId: task.id, blockId: other.id }, at("11:00")).id, "stopped", at("11:01"));
    expect(focusMinutesByBlock(t.db, [other.id]).has(other.id)).toBe(false);
    // A run on the task but not on any session of it belongs to neither.
    finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 25 }, at("12:00")).id, "completed", at("12:25"));
    expect(focusMinutesByBlock(t.db, [box.id, other.id]).get(box.id)).toBe(65);
    expect(focusMinutesByBlock(t.db, [])).toEqual(new Map());
  });

  it("refuses a blockId that does not exist, or belongs to a different task", () => {
    const a = createTask(t.db, { title: "A" });
    const b = createTask(t.db, { title: "B" });
    expect(() => startFocus(t.db, { taskId: a.id, blockId: 9999, minutes: 25 }, at("09:00"))).toThrow(FocusError);
    const block = addBlock(t.db, { taskId: b.id, startsAt: "2026-09-24T09:00:00", minutes: 25 });
    expect(() => startFocus(t.db, { taskId: a.id, blockId: block.id, minutes: 25 }, at("09:00"))).toThrow(/task/i);
    // The matching pairing is fine.
    const run = startFocus(t.db, { taskId: b.id, blockId: block.id, minutes: 25 }, at("09:00"));
    expect(run.blockId).toBe(block.id);
  });

  it("takes its length from the block's own session first, an explicit minutes second, the default only with no session at all", () => {
    const task = createTask(t.db, { title: "A" });
    const block = addBlock(t.db, { taskId: task.id, startsAt: "2026-09-24T09:00:00", minutes: 45 });
    // No explicit minutes: the block's own 45, not the 25-minute ad-hoc default.
    const fromBlock = startFocus(t.db, { taskId: task.id, blockId: block.id }, at("09:00"));
    expect(fromBlock.plannedMinutes).toBe(45);
    finishFocus(t.db, fromBlock.id, "stopped", at("09:05"));
    // An explicit minutes still wins over the block's own length.
    const explicit = startFocus(t.db, { taskId: task.id, blockId: block.id, minutes: 30 }, at("10:00"));
    expect(explicit.plannedMinutes).toBe(30);
    finishFocus(t.db, explicit.id, "stopped", at("10:05"));
    // No block at all: the saved default.
    const adHoc = startFocus(t.db, { taskId: task.id }, at("11:00"));
    expect(adHoc.plannedMinutes).toBe(25);
  });

  it("never books more than plannedMinutes + STALE_AFTER, however late the finish call arrives", () => {
    const task = createTask(t.db, { title: "A" });
    const run = startFocus(t.db, { taskId: task.id, minutes: 25 }, at("09:00"));
    // A laptop sleeps mid-run and wakes ten hours later, the tab still holding the run id.
    const done = finishFocus(t.db, run.id, "completed", at("19:00"));
    expect(done).toMatchObject({ outcome: "completed", actualMinutes: 25 });
  });

  it("forces a stale finish to \"completed\" at the planned length, whatever outcome was asked for", () => {
    const task = createTask(t.db, { title: "A" });
    const run = startFocus(t.db, { taskId: task.id, minutes: 25 }, at("09:00"));
    // 90 minutes later is well past plannedMinutes(25) + STALE_AFTER(30).
    const done = finishFocus(t.db, run.id, "stopped", at("10:30"));
    expect(done).toMatchObject({ outcome: "completed", actualMinutes: 25 });
  });

  it("an explicit \"abandoned\" wins over staleness — a discard books nothing however late it arrives", () => {
    const task = createTask(t.db, { title: "A" });
    const run = startFocus(t.db, { taskId: task.id, minutes: 25 }, at("09:00"));
    // Ten hours later, past plannedMinutes(25) + STALE_AFTER(30), the person explicitly discards it.
    const done = finishFocus(t.db, run.id, "abandoned", at("19:00"));
    expect(done).toMatchObject({ outcome: "abandoned", actualMinutes: 0 });
    expect(focusMinutesByTask(t.db, [task.id]).get(task.id) ?? 0).toBe(0);
  });

  it("books exactly the planned minutes for a completed run, not the rounded wall clock", () => {
    const task = createTask(t.db, { title: "A" });
    const run = startFocus(t.db, { taskId: task.id, minutes: 45 }, at("09:00"));
    const done = finishFocus(t.db, run.id, "completed", new Date(at("09:00").getTime() + 45 * 60_000 + 40_000)); // +45:40
    expect(done.actualMinutes).toBe(45);
  });

  it("refuses to end a run before it started", () => {
    const task = createTask(t.db, { title: "A" });
    const run = startFocus(t.db, { taskId: task.id, minutes: 25 }, at("09:00"));
    expect(() => finishFocus(t.db, run.id, "stopped", at("08:00"))).toThrow(/start/i);
  });

  it("the database itself refuses a second live run", () => {
    const task = createTask(t.db, { title: "A" });
    startFocus(t.db, { taskId: task.id, minutes: 25 }, at("09:00"));
    expect(() =>
      t.db.run(`insert into focus_runs (task_id, started_at, planned_minutes) values (${task.id}, '2026-09-24T09:05:00.000Z', 25)`),
    ).toThrow();
  });

  it("a deleted task's runs vanish from the summary, not just fail to throw", () => {
    const kept = createTask(t.db, { title: "Kept" });
    const gone = createTask(t.db, { title: "Gone" });
    finishFocus(t.db, startFocus(t.db, { taskId: kept.id, minutes: 25 }, at("09:00")).id, "completed", at("09:25"));
    finishFocus(t.db, startFocus(t.db, { taskId: gone.id, minutes: 25 }, at("10:00")).id, "completed", at("10:25"));
    t.db.run(`delete from tasks where id = ${gone.id}`);
    const s = focusSummary(t.db, { from: "2026-09-24", to: "2026-09-25" });
    expect(s).toMatchObject({ minutes: 25, runs: 1 });
    expect(s.byTask).toEqual([{ taskId: kept.id, title: "Kept", minutes: 25, runs: 1 }]);
    expect(focusMinutesByTask(t.db, [gone.id]).get(gone.id)).toBeUndefined();
  });
});

describe("focus summary", () => {
  it("sums a range by task, counting only the runs that booked minutes", () => {
    const a = createTask(t.db, { title: "A" });
    finishFocus(t.db, startFocus(t.db, { taskId: a.id, minutes: 25 }, at("09:00")).id, "completed", at("09:25"));
    finishFocus(t.db, startFocus(t.db, { taskId: a.id, minutes: 25 }, at("10:00")).id, "stopped", at("10:01"));
    const s = focusSummary(t.db, { from: "2026-09-24", to: "2026-09-25" });
    expect(s).toMatchObject({ minutes: 25, runs: 1 });
    expect(s.byTask).toEqual([{ taskId: a.id, title: "A", minutes: 25, runs: 1 }]);
    expect(completedToday(t.db, "2026-09-24")).toBe(1);
  });

  /**
   * A pomodoro started on nothing in particular is still focused work: it belongs in the day's
   * total. It cannot belong in `byTask`, which is a breakdown by task and has no task to put it
   * under -- and inventing one would attribute time to work it was not spent on.
   */
  it("counts a run with no task in the totals, but not in the per-task breakdown", () => {
    const a = createTask(t.db, { title: "A" });
    finishFocus(t.db, startFocus(t.db, { taskId: a.id, minutes: 25 }, at("09:00")).id, "completed", at("09:25"));
    finishFocus(t.db, startFocus(t.db, { minutes: 25 }, at("10:00")).id, "completed", at("10:25"));

    const s = focusSummary(t.db, { from: "2026-09-24", to: "2026-09-25" });
    expect(s).toMatchObject({ minutes: 50, runs: 2 });
    expect(s.byTask).toEqual([{ taskId: a.id, title: "A", minutes: 25, runs: 1 }]);
    // It still counts towards the long-break cycle: it was a pomodoro like any other.
    expect(completedToday(t.db, "2026-09-24")).toBe(2);
  });

  it("sums across a multi-day range, with `to` exclusive of the boundary day", () => {
    const task = createTask(t.db, { title: "A" });
    finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 25 }, at("09:00")).id, "completed", at("09:25")); // 24th
    finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 20 }, atNextDay("09:00")).id, "completed", atNextDay("09:20")); // 25th
    const onBoundary = new Date(2026, 8, 26, 9, 0); // 26th — must fall outside to="2026-09-26"
    finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 15 }, onBoundary).id, "completed", new Date(2026, 8, 26, 9, 15));

    const s = focusSummary(t.db, { from: "2026-09-24", to: "2026-09-26" });
    expect(s).toMatchObject({ minutes: 45, runs: 2 });
  });

  it("a run started late at night belongs to the local day it started, even once reconciled the next morning", () => {
    const task = createTask(t.db, { title: "Night owl" });
    startFocus(t.db, { taskId: task.id, minutes: 20 }, at("23:50")); // planned end 00:10 the 25th
    // Reconciled well past the grace period, the next morning.
    expect(runningFocus(t.db, atNextDay("07:00"))).toBeNull();
    const startDay = focusSummary(t.db, { from: "2026-09-24", to: "2026-09-25" });
    expect(startDay).toMatchObject({ minutes: 20, runs: 1 });
    const readDay = focusSummary(t.db, { from: "2026-09-25", to: "2026-09-26" });
    expect(readDay).toMatchObject({ minutes: 0, runs: 0 });
  });
});

// Seeds one continuous session in the given app/domain from `from` to `to`, ten minutes at a
// time — within `ingestHeartbeat`'s 15-minute fold gap, so it lands as one row, not several.
function seedSession(db: TestDb["db"], appId: string, appName: string, from: Date, to: Date, url: string | null = null): void {
  const STEP_MS = 10 * 60_000;
  let cursor = from.getTime();
  ingestHeartbeat(db, { at: new Date(cursor).toISOString(), appId, appName, title: appName, url });
  while (cursor < to.getTime()) {
    cursor = Math.min(cursor + STEP_MS, to.getTime());
    ingestHeartbeat(db, { at: new Date(cursor).toISOString(), appId, appName, title: appName, url });
  }
}

describe("focusWhere", () => {
  it("answers [] when the helper has never reported anything at all", () => {
    const task = createTask(t.db, { title: "A" });
    const run = finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 20 }, at("09:00")).id, "completed", at("09:20"));
    expect(focusWhere(t.db, run)).toEqual([]);
  });

  it("answers [] when the day has activity but none of it overlaps the run — distinct from never reporting", () => {
    const task = createTask(t.db, { title: "A" });
    const run = finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 20 }, at("09:00")).id, "completed", at("09:20"));
    // Real activity that day, nowhere near the run's own window.
    seedSession(t.db, "com.apple.Notes", "Notes", at("14:00"), at("14:30"));
    expect(focusWhere(t.db, run)).toEqual([]);
  });

  it("clips overlap to the run's own window, not the session's", () => {
    const task = createTask(t.db, { title: "A" });
    // The session runs from before the run to after it.
    seedSession(t.db, "com.microsoft.VSCode", "Code", at("08:50"), at("09:40"));
    const run = finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 30 }, at("09:00")).id, "completed", at("09:30"));
    expect(focusWhere(t.db, run)).toEqual([{ label: "Code", ms: 30 * 60_000 }]);
  });

  it("names a browser by its busiest domain when a domain took over half its time", () => {
    const task = createTask(t.db, { title: "A" });
    // 15 minutes on a domain, 5 minutes without one: over half the app's time was on the domain.
    seedSession(t.db, "com.google.Chrome", "Chrome", at("09:00"), at("09:15"), "https://github.com/x");
    seedSession(t.db, "com.google.Chrome", "Chrome", at("09:15"), at("09:20"), null);
    const run = finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 20 }, at("09:00")).id, "completed", at("09:20"));
    expect(focusWhere(t.db, run)).toEqual([{ label: "github.com", ms: 20 * 60_000 }]);
  });

  it("keeps the app's own name when no domain took over half its time", () => {
    const task = createTask(t.db, { title: "A" });
    // 8 minutes on a domain, 12 without one: the domain never crosses half the app's total time.
    seedSession(t.db, "com.google.Chrome", "Chrome", at("09:00"), at("09:08"), "https://github.com/x");
    seedSession(t.db, "com.google.Chrome", "Chrome", at("09:08"), at("09:20"), null);
    const run = finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 20 }, at("09:00")).id, "completed", at("09:20"));
    expect(focusWhere(t.db, run)).toEqual([{ label: "Chrome", ms: 20 * 60_000 }]);
  });

  it("names at most three apps, ranked by time spent", () => {
    const task = createTask(t.db, { title: "A" });
    seedSession(t.db, "app.a", "App A", at("09:00"), at("09:10")); // 10 min
    seedSession(t.db, "app.b", "App B", at("09:10"), at("09:18")); // 8 min
    seedSession(t.db, "app.c", "App C", at("09:18"), at("09:23")); // 5 min
    seedSession(t.db, "app.d", "App D", at("09:23"), at("09:25")); // 2 min, dropped
    const run = finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 25 }, at("09:00")).id, "completed", at("09:25"));
    expect(focusWhere(t.db, run)).toEqual([
      { label: "App A", ms: 10 * 60_000 },
      { label: "App B", ms: 8 * 60_000 },
      { label: "App C", ms: 5 * 60_000 },
    ]);
  });

  it("spans every local day the run touches, not just the one it started on", () => {
    const task = createTask(t.db, { title: "Night owl" });
    // The session itself crosses local midnight; the app switch happens at 00:05 the 25th.
    seedSession(t.db, "app.a", "App A", at("23:50"), atNextDay("00:05"));
    seedSession(t.db, "app.b", "App B", atNextDay("00:05"), atNextDay("00:15"));
    const run = finishFocus(t.db, startFocus(t.db, { taskId: task.id, minutes: 25 }, at("23:50")).id, "completed", atNextDay("00:15"));
    expect(focusWhere(t.db, run)).toEqual([
      { label: "App A", ms: 15 * 60_000 },
      { label: "App B", ms: 10 * 60_000 },
    ]);
  });
});

describe("estimateActualPairs", () => {
  it("sums a task's runs into one pair, and skips a task with no estimate, one still open, and one with only an abandoned run", () => {
    const twoRuns = createTask(t.db, { title: "Two runs", estimateMinutes: 60 });
    finishFocus(t.db, startFocus(t.db, { taskId: twoRuns.id, minutes: 30 }, at("09:00")).id, "completed", at("09:30"));
    finishFocus(t.db, startFocus(t.db, { taskId: twoRuns.id, minutes: 30 }, at("10:00")).id, "completed", at("10:30"));
    completeTask(t.db, twoRuns.id);

    const noEstimate = createTask(t.db, { title: "No estimate" });
    finishFocus(t.db, startFocus(t.db, { taskId: noEstimate.id, minutes: 30 }, at("09:00")).id, "completed", at("09:30"));
    completeTask(t.db, noEstimate.id);

    const stillOpen = createTask(t.db, { title: "Still open", estimateMinutes: 30 });
    finishFocus(t.db, startFocus(t.db, { taskId: stillOpen.id, minutes: 30 }, at("09:00")).id, "completed", at("09:30"));

    const onlyAbandoned = createTask(t.db, { title: "Only abandoned", estimateMinutes: 30 });
    finishFocus(t.db, startFocus(t.db, { taskId: onlyAbandoned.id, minutes: 30 }, at("09:00")).id, "abandoned", at("09:01"));
    completeTask(t.db, onlyAbandoned.id);

    expect(estimateActualPairs(t.db)).toEqual([{ estimateMinutes: 60, actualMinutes: 60 }]);
  });

  it("reads newest completion first", () => {
    const older = createTask(t.db, { title: "Older", estimateMinutes: 30 });
    finishFocus(t.db, startFocus(t.db, { taskId: older.id, minutes: 30 }, at("09:00")).id, "completed", at("09:30"));
    completeTask(t.db, older.id);
    t.db.run(`update tasks set completed_at = '2026-09-01T12:00:00.000Z' where id = ${older.id}`);

    const newer = createTask(t.db, { title: "Newer", estimateMinutes: 20 });
    finishFocus(t.db, startFocus(t.db, { taskId: newer.id, minutes: 20 }, at("09:00")).id, "completed", at("09:20"));
    completeTask(t.db, newer.id);
    t.db.run(`update tasks set completed_at = '2026-09-20T12:00:00.000Z' where id = ${newer.id}`);

    expect(estimateActualPairs(t.db)).toEqual([
      { estimateMinutes: 20, actualMinutes: 20 },
      { estimateMinutes: 30, actualMinutes: 30 },
    ]);
  });

  it("respects the limit by keeping the newest, not just some two of the three", () => {
    // Distinct estimates and completion dates, so a limit that silently kept the two *oldest*
    // (which would also satisfy a bare `toHaveLength(2)`) is told apart from the correct answer.
    const oldest = createTask(t.db, { title: "Oldest", estimateMinutes: 10 });
    finishFocus(t.db, startFocus(t.db, { taskId: oldest.id, minutes: 10 }, at("09:00")).id, "completed", at("09:10"));
    completeTask(t.db, oldest.id);
    t.db.run(`update tasks set completed_at = '2026-09-01T12:00:00.000Z' where id = ${oldest.id}`);

    const middle = createTask(t.db, { title: "Middle", estimateMinutes: 20 });
    finishFocus(t.db, startFocus(t.db, { taskId: middle.id, minutes: 20 }, at("09:00")).id, "completed", at("09:20"));
    completeTask(t.db, middle.id);
    t.db.run(`update tasks set completed_at = '2026-09-10T12:00:00.000Z' where id = ${middle.id}`);

    const newest = createTask(t.db, { title: "Newest", estimateMinutes: 30 });
    finishFocus(t.db, startFocus(t.db, { taskId: newest.id, minutes: 30 }, at("09:00")).id, "completed", at("09:30"));
    completeTask(t.db, newest.id);
    t.db.run(`update tasks set completed_at = '2026-09-20T12:00:00.000Z' where id = ${newest.id}`);

    expect(estimateActualPairs(t.db, 2)).toEqual([
      { estimateMinutes: 30, actualMinutes: 30 },
      { estimateMinutes: 20, actualMinutes: 20 },
    ]);
  });
});

describe("likeThisMinutesByTask", () => {
  /** A finished task that booked exactly `minutes`, in `containerId` — one call for the whole
   * shape `similarActualMinutes` reads as a candidate. */
  function doneTask(containerId: number, title: string, minutes: number) {
    const task = createTask(t.db, { title, containerId });
    const run = startFocus(t.db, { taskId: task.id, minutes }, at("09:00"));
    finishFocus(t.db, run.id, "completed", new Date(at("09:00").getTime() + minutes * 60_000));
    completeTask(t.db, task.id);
    return task;
  }

  it("is the median actual of done, booked tasks in the same container sharing a meaningful word", () => {
    const project = createContainer(t.db, { kind: "project", name: "Website" });
    doneTask(project.id, "Draft the quarterly report", 40);
    doneTask(project.id, "Send the quarterly report", 60);
    doneTask(project.id, "Review last quarterly numbers", 50);
    const open = createTask(t.db, { title: "Write the quarterly summary", containerId: project.id });
    expect(likeThisMinutesByTask(t.db, [open]).get(open.id)).toBe(50);
  });

  it("matches after lowercasing both titles", () => {
    const project = createContainer(t.db, { kind: "project", name: "Website" });
    doneTask(project.id, "DRAFT the Quarterly report", 40);
    doneTask(project.id, "send the QUARTERLY report", 60);
    doneTask(project.id, "Review last Quarterly numbers", 50);
    const open = createTask(t.db, { title: "write the quarterly summary", containerId: project.id });
    expect(likeThisMinutesByTask(t.db, [open]).get(open.id)).toBe(50);
  });

  it("is null with fewer than three matches", () => {
    const project = createContainer(t.db, { kind: "project", name: "Website" });
    doneTask(project.id, "Draft the quarterly report", 40);
    doneTask(project.id, "Send the quarterly report", 60);
    const open = createTask(t.db, { title: "Write the quarterly summary", containerId: project.id });
    expect(likeThisMinutesByTask(t.db, [open]).get(open.id)).toBeNull();
  });

  it("is null with no container to match against", () => {
    const open = createTask(t.db, { title: "Write the quarterly summary" });
    expect(likeThisMinutesByTask(t.db, [open]).get(open.id)).toBeNull();
  });

  it("does not count a shared word under four letters", () => {
    const project = createContainer(t.db, { kind: "project", name: "Website" });
    // Every candidate shares only "fix" (three letters) with the open task's title — too short
    // to mean two tasks are alike, so none of these count as a match.
    doneTask(project.id, "Fix the bug in the nav", 30);
    doneTask(project.id, "Fix the css for the nav", 20);
    doneTask(project.id, "Fix the log for the run", 10);
    const open = createTask(t.db, { title: "Fix one more thing", containerId: project.id });
    expect(likeThisMinutesByTask(t.db, [open]).get(open.id)).toBeNull();
  });

  it("does not count a done task in a different container, even sharing a word", () => {
    const a = createContainer(t.db, { kind: "project", name: "A" });
    const b = createContainer(t.db, { kind: "project", name: "B" });
    doneTask(a.id, "Draft the quarterly report", 40);
    doneTask(a.id, "Send the quarterly report", 60);
    doneTask(a.id, "Review the quarterly numbers", 50);
    const open = createTask(t.db, { title: "Write the quarterly summary", containerId: b.id });
    expect(likeThisMinutesByTask(t.db, [open]).get(open.id)).toBeNull();
  });

  it("does not count a still-open task or one with only an abandoned run", () => {
    const project = createContainer(t.db, { kind: "project", name: "Website" });
    doneTask(project.id, "Draft the quarterly report", 40);
    doneTask(project.id, "Send the quarterly report", 60);
    // Still open: not finished at all.
    createTask(t.db, { title: "Review the quarterly numbers", containerId: project.id });
    // Only an abandoned run: booked nothing, so "done with booked minutes" still fails it.
    const abandoned = createTask(t.db, { title: "Close the quarterly books", containerId: project.id });
    finishFocus(t.db, startFocus(t.db, { taskId: abandoned.id, minutes: 5 }, at("09:00")).id, "abandoned", at("09:01"));
    completeTask(t.db, abandoned.id);
    const open = createTask(t.db, { title: "Write the quarterly summary", containerId: project.id });
    expect(likeThisMinutesByTask(t.db, [open]).get(open.id)).toBeNull();
  });

  it("costs one query for the whole list, never one per row", () => {
    const project = createContainer(t.db, { kind: "project", name: "Website" });
    doneTask(project.id, "Draft the quarterly report", 40);
    doneTask(project.id, "Send the quarterly report", 60);
    doneTask(project.id, "Review last quarterly numbers", 50);
    const list = Array.from({ length: 20 }, (_, i) => createTask(t.db, { title: `Write quarterly summary ${i}`, containerId: project.id }));
    const spy = vi.spyOn(t.db, "select");
    const out = likeThisMinutesByTask(t.db, list);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.get(list[0].id)).toBe(50);
    expect(out.get(list[19].id)).toBe(50);
  });

  it("similarActualMinutes reads the same figure for a single task", () => {
    const project = createContainer(t.db, { kind: "project", name: "Website" });
    doneTask(project.id, "Draft the quarterly report", 40);
    doneTask(project.id, "Send the quarterly report", 60);
    doneTask(project.id, "Review last quarterly numbers", 50);
    const open = createTask(t.db, { title: "Write the quarterly summary", containerId: project.id });
    expect(similarActualMinutes(t.db, open)).toBe(50);
  });

  it("the match floor is three", () => {
    expect(LIKE_THIS_MIN_MATCHES).toBe(3);
  });
});
