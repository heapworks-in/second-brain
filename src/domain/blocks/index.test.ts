import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { eq } from "drizzle-orm";
import { calendarEvents } from "@/db/schema";
import { replaceCalendarEvents } from "@/domain/activity";
import { addToPlan } from "@/domain/plan";
import { freeMinutes } from "@/lib/capacity";
import { setMeetingDecision } from "@/domain/meetings/decision";
import { completeTask, createTask, deleteTask, dropTask, getTask } from "@/domain/tasks";
import { addBlock, appendBlock, blocksByTask, BlockError, clearBlocks, fillDay, listBlocks, placeTask, removeBlock, updateBlock } from "./index";

const DAY = "2026-10-05";
const NEXT = "2026-10-06";

/** The local day of a Date, the way the domain reads one. */
function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A timed meeting on `DAY`, so a placement has something to work around. */
function meeting(externalId: string, from: string, to: string, over: { status?: "declined"; allDay?: boolean } = {}) {
  return { externalId, title: "Sync", startsAt: `${DAY}T${from}:00`, endsAt: `${DAY}T${to}:00`, attendees: 2, hasCallLink: true, ...over };
}

describe("blocks domain", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("adds a session and refuses a bad start, a bad length, or an unknown task", () => {
    const task = createTask(t.db, { title: "Write" });
    const block = addBlock(t.db, { taskId: task.id, startsAt: `${DAY}T10:00:00`, minutes: 45 });
    expect(block).toMatchObject({ taskId: task.id, startsAt: `${DAY}T10:00:00`, minutes: 45 });
    expect(() => addBlock(t.db, { taskId: task.id, startsAt: `${DAY} 10:00`, minutes: 45 })).toThrow(/YYYY-MM-DDTHH:MM:SS/);
    expect(() => addBlock(t.db, { taskId: task.id, startsAt: `${DAY}T25:00:00`, minutes: 45 })).toThrow(/YYYY-MM-DDTHH:MM:SS/);
    expect(() => addBlock(t.db, { taskId: task.id, startsAt: `${DAY}T10:00:00`, minutes: 4 })).toThrow(/5 and 480/);
    expect(() => addBlock(t.db, { taskId: task.id, startsAt: `${DAY}T10:00:00`, minutes: 481 })).toThrow(/5 and 480/);
    expect(() => addBlock(t.db, { taskId: 999, startsAt: `${DAY}T10:00:00`, minutes: 45 })).toThrow(BlockError);
  });

  describe("another box", () => {
    /** 10:00 on the day in hand, so the first free time is the morning rather than the hour the
     * suite happens to run in. */
    const at10 = new Date(`${DAY}T10:00:00`);

    it("puts one more session in the first free time at or after now", () => {
      const task = createTask(t.db, { title: "Migrate" });
      replaceCalendarEvents(t.db, [meeting("sync", "11:00", "12:00")]);
      // 10:00 to 11:00 has room for a 45-minute box, so that is where it goes.
      expect(appendBlock(t.db, { taskId: task.id, minutes: 45, date: DAY, now: at10 })).toMatchObject({ startsAt: `${DAY}T10:00:00`, minutes: 45 });
      // A 90-minute box does not fit that hour, and is never cut in half to make it: it waits
      // for the first slot that holds the whole of it.
      expect(appendBlock(t.db, { taskId: task.id, minutes: 90, date: DAY, now: at10 })).toMatchObject({ startsAt: `${DAY}T12:00:00`, minutes: 90 });
    });

    it("leaves every session already on the day where it is", () => {
      const task = createTask(t.db, { title: "Migrate" });
      const afternoon = addBlock(t.db, { taskId: task.id, startsAt: `${DAY}T14:00:00`, minutes: 60 });
      appendBlock(t.db, { taskId: task.id, minutes: 45, date: DAY, now: at10 });
      const starts = listBlocks(t.db, { taskId: task.id, date: DAY }).map((b) => b.startsAt);
      expect(starts).toEqual([`${DAY}T10:00:00`, `${DAY}T14:00:00`]);
      expect(getTask(t.db, task.id)).toBeTruthy();
      expect(listBlocks(t.db, { taskId: task.id, date: DAY }).find((b) => b.id === afternoon.id)!.minutes).toBe(60);
    });

    it("says so rather than squeezing when the day has no room left", () => {
      const task = createTask(t.db, { title: "Migrate" });
      replaceCalendarEvents(t.db, [meeting("all-day-sync", "09:00", "18:00")]);
      expect(() => appendBlock(t.db, { taskId: task.id, minutes: 45, date: DAY, now: at10 })).toThrow(/No 45 free minutes/);
    });

    it("checks its task, its date and its length", () => {
      const task = createTask(t.db, { title: "Migrate" });
      expect(() => appendBlock(t.db, { taskId: 999, minutes: 45, date: DAY, now: at10 })).toThrow(BlockError);
      expect(() => appendBlock(t.db, { taskId: task.id, minutes: 45, date: "05-10-2026", now: at10 })).toThrow(/YYYY-MM-DD/);
      expect(() => appendBlock(t.db, { taskId: task.id, minutes: 4, date: DAY, now: at10 })).toThrow(/5 and 480/);
    });
  });

  it("moves and resizes a session, pulling the estimate up to the day's sessions", () => {
    const task = createTask(t.db, { title: "Write", estimateMinutes: 60 });
    const block = addBlock(t.db, { taskId: task.id, startsAt: `${DAY}T10:00:00`, minutes: 45 });
    expect(updateBlock(t.db, block.id, { startsAt: `${DAY}T11:00:00` }).startsAt).toBe(`${DAY}T11:00:00`);
    // Still inside the hour the task was estimated at: the estimate is left alone.
    expect(updateBlock(t.db, block.id, { minutes: 50 }).minutes).toBe(50);
    expect(getTask(t.db, task.id)!.estimateMinutes).toBe(60);
    // Past it now, so the total grows to match what the day holds.
    addBlock(t.db, { taskId: task.id, startsAt: `${DAY}T14:00:00`, minutes: 30 });
    updateBlock(t.db, block.id, { minutes: 60 });
    expect(getTask(t.db, task.id)!.estimateMinutes).toBe(90);
    expect(() => updateBlock(t.db, block.id, { minutes: 0 })).toThrow(/5 and 480/);
    expect(() => updateBlock(t.db, 999, { minutes: 30 })).toThrow(BlockError);
  });

  it("gives an unguessed task the estimate its sessions add up to", () => {
    const task = createTask(t.db, { title: "Write" });
    const block = addBlock(t.db, { taskId: task.id, startsAt: `${DAY}T10:00:00`, minutes: 25 });
    updateBlock(t.db, block.id, { minutes: 90 });
    expect(getTask(t.db, task.id)!.estimateMinutes).toBe(90);
  });

  it("removes one session, clears a day's, and lists a day's in clock order", () => {
    const a = createTask(t.db, { title: "A" });
    const b = createTask(t.db, { title: "B" });
    const first = addBlock(t.db, { taskId: a.id, startsAt: `${DAY}T09:00:00`, minutes: 30 });
    addBlock(t.db, { taskId: a.id, startsAt: `${DAY}T15:00:00`, minutes: 30 });
    addBlock(t.db, { taskId: a.id, startsAt: `${NEXT}T09:00:00`, minutes: 30 });
    addBlock(t.db, { taskId: b.id, startsAt: `${DAY}T11:00:00`, minutes: 30 });
    expect(listBlocks(t.db, { date: DAY }).map((x) => [x.taskId, x.startsAt])).toEqual([
      [a.id, `${DAY}T09:00:00`],
      [b.id, `${DAY}T11:00:00`],
      [a.id, `${DAY}T15:00:00`],
    ]);
    removeBlock(t.db, first.id);
    expect(() => removeBlock(t.db, first.id)).toThrow(BlockError);
    expect(clearBlocks(t.db, a.id, DAY)).toBe(1);
    expect(listBlocks(t.db, { taskId: a.id }).map((x) => x.startsAt)).toEqual([`${NEXT}T09:00:00`]);
    const byTask = blocksByTask(t.db, [a.id, b.id]);
    expect(byTask.get(a.id)!.map((x) => x.startsAt)).toEqual([`${NEXT}T09:00:00`]);
    expect(byTask.get(b.id)!).toHaveLength(1);
  });

  it("lays a task's sessions into the free slots around meetings and other tasks", () => {
    replaceCalendarEvents(t.db, [meeting("m1", "10:00", "11:00"), meeting("m2", "16:00", "17:00", { status: "declined" })]);
    const other = createTask(t.db, { title: "Other" });
    addBlock(t.db, { taskId: other.id, startsAt: `${DAY}T14:00:00`, minutes: 60 });
    const task = createTask(t.db, { title: "Write", estimateMinutes: 120 });
    expect(placeTask(t.db, { taskId: task.id, date: DAY })).toEqual({ placed: 3, unplacedMinutes: 0 });
    const placed = listBlocks(t.db, { taskId: task.id });
    // 120 minutes at 45 apiece is 45 + 45 + 30, and ten minutes stand between two of them in
    // one slot. 09:00–09:45 fills the morning slot: the break would leave only five minutes
    // of it, under the floor, so the second session waits for the meeting to end at 11:00 and
    // starts there with no break before it. The third takes its break: 11:55–12:25.
    expect(placed.map((b) => [b.startsAt.slice(11, 16), b.minutes])).toEqual([
      ["09:00", 45],
      ["11:00", 45],
      ["11:55", 30],
    ]);
    expect(placed.reduce((n, b) => n + b.minutes, 0)).toBe(120);
    // A declined meeting is not busy, and nothing lands inside the one that stands.
    expect(placed.some((b) => b.startsAt >= `${DAY}T10:00:00` && b.startsAt < `${DAY}T11:00:00`)).toBe(false);
  });

  // Finding 5: the scheduler must agree with `freeMinutes` about the same hour. A meeting the
  // calendar still calls "accepted" but the person has locally marked not-going must free its
  // time here exactly as a calendar-declined meeting already does — the local decision, not the
  // calendar's own RSVP, is what actually governs.
  it("frees a meeting's slot once the person marks it not-going locally, even while the calendar still calls it accepted", async () => {
    const { calendarEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    // The morning is entirely taken by another task's own sessions, so the only room left for
    // this one is whatever 16:00-18:00 gives up -- which is either the whole two hours (meeting
    // freed) or just the last one (meeting still counted busy).
    replaceCalendarEvents(t.db, [meeting("m1", "16:00", "17:00")]);
    const ev = t.db.select().from(calendarEvents).where(eq(calendarEvents.externalId, "m1")).get()!;
    expect(ev.status).toBe("none");
    setMeetingDecision(t.db, ev.id, { decision: "not-going", scope: "occurrence" });

    const other = createTask(t.db, { title: "Other" });
    addBlock(t.db, { taskId: other.id, startsAt: `${DAY}T09:00:00`, minutes: 420 });
    const task = createTask(t.db, { title: "Write", estimateMinutes: 90 });
    // 90 minutes splits into two 45-minute sessions with a 10-minute gap: they only both fit in
    // the freed 16:00-18:00 window (120 min); the busy-until-17:00 reading only has room for one.
    expect(placeTask(t.db, { taskId: task.id, date: DAY })).toEqual({ placed: 2, unplacedMinutes: 0 });
    const placed = listBlocks(t.db, { taskId: task.id });
    expect(placed.some((b) => b.startsAt >= `${DAY}T16:00:00` && b.startsAt < `${DAY}T17:00:00`)).toBe(true);
  });

  // F-D (final whole-branch review): `busySpans` excluded only `not-going`, so a `maybe` meeting
  // blocked its whole hour for auto-placement while `freeMinutes` already reported half that hour
  // as free — "Fill the day" could leave a genuinely available half-hour unplaced, with both
  // files' own comments claiming the two must never disagree about the same hour. Same class of
  // bug as Task 2's Finding 5 above, one decision value over.
  it("blocks only the half of a maybe meeting that capacity charges, so the scheduler and the capacity line agree about that hour", () => {
    replaceCalendarEvents(t.db, [meeting("m1", "10:00", "11:00")]);
    const ev = t.db.select().from(calendarEvents).where(eq(calendarEvents.externalId, "m1")).get()!;
    setMeetingDecision(t.db, ev.id, { decision: "maybe", scope: "occurrence" });

    // What the capacity line says about that one hour: a half-commitment holds half a slot, so
    // thirty of its sixty minutes are free time (`meetingCost`).
    const capacityFree = freeMinutes([{ startsAt: `${DAY}T10:00:00`, endsAt: `${DAY}T11:00:00`, allDay: false, decision: "maybe" }], "10:00-11:00", DAY);
    expect(capacityFree).toBe(30);

    // Every other minute of the working day is spoken for by another task's sessions, so the only
    // room the scheduler has is whatever this hour gives up.
    const other = createTask(t.db, { title: "Other" });
    addBlock(t.db, { taskId: other.id, startsAt: `${DAY}T09:00:00`, minutes: 60 });
    addBlock(t.db, { taskId: other.id, startsAt: `${DAY}T11:00:00`, minutes: 420 });

    const task = createTask(t.db, { title: "Write", estimateMinutes: 30 });
    // Before the fix this placed nothing: the whole hour read busy.
    expect(placeTask(t.db, { taskId: task.id, date: DAY })).toEqual({ placed: 1, unplacedMinutes: 0 });
    const [placed] = listBlocks(t.db, { taskId: task.id });
    // The back half, because the charged half is taken from the meeting's start.
    expect([placed.startsAt.slice(11, 16), placed.minutes]).toEqual(["10:30", 30]);
    // The whole point: the scheduler placed exactly the minutes capacity called free, not more.
    expect(placed.minutes).toBe(capacityFree);
  });

  it("frees nothing extra for a maybe meeting sitting on top of a going one, exactly as freeMinutes does not", () => {
    replaceCalendarEvents(t.db, [meeting("going", "10:00", "11:00"), meeting("maybe", "10:00", "11:00")]);
    const overlapping = t.db.select().from(calendarEvents).where(eq(calendarEvents.externalId, "maybe")).get()!;
    setMeetingDecision(t.db, overlapping.id, { decision: "maybe", scope: "occurrence" });

    // `freeMinutes` charges the going meeting the full hour and the maybe nothing on top of it
    // (`outsideCover`): time already fully spoken for cannot be half-spoken-for as well.
    const both = [
      { startsAt: `${DAY}T10:00:00`, endsAt: `${DAY}T11:00:00`, allDay: false, decision: "going" as const },
      { startsAt: `${DAY}T10:00:00`, endsAt: `${DAY}T11:00:00`, allDay: false, decision: "maybe" as const },
    ];
    expect(freeMinutes(both, "10:00-11:00", DAY)).toBe(0);

    const other = createTask(t.db, { title: "Other" });
    addBlock(t.db, { taskId: other.id, startsAt: `${DAY}T09:00:00`, minutes: 60 });
    addBlock(t.db, { taskId: other.id, startsAt: `${DAY}T11:00:00`, minutes: 420 });
    const task = createTask(t.db, { title: "Write", estimateMinutes: 15 });
    // The maybe's half span falls inside the going meeting's own, so merging leaves no gap.
    expect(placeTask(t.db, { taskId: task.id, date: DAY })).toEqual({ placed: 0, unplacedMinutes: 15 });
  });

  it("starts no earlier than now when the day is today", () => {
    const now = new Date();
    now.setHours(12, 7, 0, 0);
    const today = localDay(now);
    const task = createTask(t.db, { title: "Write", estimateMinutes: 30 });
    expect(placeTask(t.db, { taskId: task.id, date: today, now })).toEqual({ placed: 1, unplacedMinutes: 0 });
    expect(listBlocks(t.db, { taskId: task.id })[0].startsAt).toBe(`${today}T12:10:00`);
  });

  it("re-places a task over its own day and leaves its other days alone", () => {
    const task = createTask(t.db, { title: "Write", estimateMinutes: 60, sessionMinutes: 30 });
    addBlock(t.db, { taskId: task.id, startsAt: `${NEXT}T09:00:00`, minutes: 60 });
    placeTask(t.db, { taskId: task.id, date: DAY });
    const first = listBlocks(t.db, { taskId: task.id, date: DAY }).map((b) => b.id);
    expect(first).toHaveLength(2);
    placeTask(t.db, { taskId: task.id, date: DAY });
    const second = listBlocks(t.db, { taskId: task.id, date: DAY });
    expect(second).toHaveLength(2);
    // Fresh rows, in the same places: the old ones went before the new ones were laid.
    expect(second.some((b) => first.includes(b.id))).toBe(false);
    // 09:00–09:30, ten minutes off, 09:40–10:10: both sessions sit in the one free slot.
    expect(second.map((b) => b.startsAt.slice(11, 16))).toEqual(["09:00", "09:40"]);
    expect(listBlocks(t.db, { taskId: task.id, date: NEXT }).map((b) => b.startsAt)).toEqual([`${NEXT}T09:00:00`]);
  });

  it("reports what the day had no room for", () => {
    replaceCalendarEvents(t.db, [meeting("m1", "09:00", "17:30")]);
    const task = createTask(t.db, { title: "Write", estimateMinutes: 90 });
    expect(placeTask(t.db, { taskId: task.id, date: DAY })).toEqual({ placed: 1, unplacedMinutes: 60 });
    expect(listBlocks(t.db, { taskId: task.id }).map((b) => [b.startsAt.slice(11, 16), b.minutes])).toEqual([["17:30", 30]]);
  });

  it("places a task nobody has estimated as one 25-minute session", () => {
    const task = createTask(t.db, { title: "Write" });
    expect(placeTask(t.db, { taskId: task.id, date: DAY })).toEqual({ placed: 1, unplacedMinutes: 0 });
    expect(listBlocks(t.db, { taskId: task.id }).map((b) => b.minutes)).toEqual([25]);
  });

  it("refuses to place an unknown task or a date that is not a date", () => {
    const task = createTask(t.db, { title: "Write" });
    expect(() => placeTask(t.db, { taskId: 999, date: DAY })).toThrow(BlockError);
    expect(() => placeTask(t.db, { taskId: task.id, date: "05-10-2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => fillDay(t.db, { date: "nope" })).toThrow(/YYYY-MM-DD/);
  });

  it("fills the day for the open plan tasks that hold no session yet", () => {
    const blocked = createTask(t.db, { title: "Already placed", estimateMinutes: 30 });
    const open = createTask(t.db, { title: "Waiting", estimateMinutes: 60 });
    const done = createTask(t.db, { title: "Finished", estimateMinutes: 60 });
    const offPlan = createTask(t.db, { title: "Not on the plan", estimateMinutes: 60 });
    addBlock(t.db, { taskId: blocked.id, startsAt: `${DAY}T09:00:00`, minutes: 30 });
    for (const task of [blocked, open, done]) addToPlan(t.db, DAY, task.id);
    completeTask(t.db, done.id);
    expect(fillDay(t.db, { date: DAY })).toEqual({ placed: 1, unplacedMinutes: 0 });
    expect(listBlocks(t.db, { taskId: open.id }).map((b) => [b.startsAt.slice(11, 16), b.minutes])).toEqual([["09:30", 60]]);
    expect(listBlocks(t.db, { taskId: blocked.id })).toHaveLength(1);
    expect(listBlocks(t.db, { taskId: offPlan.id })).toEqual([]);
    expect(listBlocks(t.db, { taskId: done.id })).toEqual([]);
  });

  it("gives the day's hours back when a task is dropped", () => {
    const first = createTask(t.db, { title: "Abandoned", estimateMinutes: 60 });
    placeTask(t.db, { taskId: first.id, date: DAY });
    expect(listBlocks(t.db, { taskId: first.id, date: DAY }).map((b) => b.startsAt.slice(11, 16))).toEqual(["09:00"]);
    dropTask(t.db, first.id);
    // The sessions go with it, so the day reads as empty again.
    expect(listBlocks(t.db, { date: DAY })).toEqual([]);
    const next = createTask(t.db, { title: "Instead", estimateMinutes: 60 });
    placeTask(t.db, { taskId: next.id, date: DAY });
    expect(listBlocks(t.db, { taskId: next.id, date: DAY }).map((b) => b.startsAt.slice(11, 16))).toEqual(["09:00"]);
  });

  it("leaves a dropped task's leftover session out of the busy hours", () => {
    const dropped = createTask(t.db, { title: "Abandoned", estimateMinutes: 60 });
    addBlock(t.db, { taskId: dropped.id, startsAt: `${DAY}T09:00:00`, minutes: 60 });
    // Straight to the row, the way an older write left one behind: the status alone must do it.
    dropTask(t.db, dropped.id);
    addBlock(t.db, { taskId: dropped.id, startsAt: `${DAY}T09:00:00`, minutes: 60 });
    const task = createTask(t.db, { title: "Write", estimateMinutes: 60 });
    placeTask(t.db, { taskId: task.id, date: DAY });
    expect(listBlocks(t.db, { taskId: task.id, date: DAY }).map((b) => b.startsAt.slice(11, 16))).toEqual(["09:00"]);
  });

  it("fills the day once: a second run finds every plan task already placed", () => {
    const a = createTask(t.db, { title: "First", estimateMinutes: 60 });
    const b = createTask(t.db, { title: "Second", estimateMinutes: 30 });
    for (const task of [a, b]) addToPlan(t.db, DAY, task.id);
    expect(fillDay(t.db, { date: DAY })).toEqual({ placed: 2, unplacedMinutes: 0 });
    const before = listBlocks(t.db, { date: DAY }).map((x) => [x.taskId, x.startsAt, x.minutes]);
    expect(fillDay(t.db, { date: DAY })).toEqual({ placed: 0, unplacedMinutes: 0 });
    expect(listBlocks(t.db, { date: DAY }).map((x) => [x.taskId, x.startsAt, x.minutes])).toEqual(before);
  });

  it("places nothing on a day whose working hours are already behind now", () => {
    const now = new Date();
    now.setHours(23, 30, 0, 0);
    const today = localDay(now);
    const task = createTask(t.db, { title: "Too late", estimateMinutes: 45 });
    addToPlan(t.db, today, task.id);
    expect(placeTask(t.db, { taskId: task.id, date: today, now })).toEqual({ placed: 0, unplacedMinutes: 45 });
    expect(fillDay(t.db, { date: today, now })).toEqual({ placed: 0, unplacedMinutes: 45 });
    expect(listBlocks(t.db, { date: today })).toEqual([]);
  });

  it("takes a task's sessions with it when the task is deleted", () => {
    const task = createTask(t.db, { title: "Write" });
    addBlock(t.db, { taskId: task.id, startsAt: `${DAY}T10:00:00`, minutes: 30 });
    deleteTask(t.db, task.id);
    expect(listBlocks(t.db, { taskId: task.id })).toEqual([]);
  });
});
