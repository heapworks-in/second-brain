import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "@/test/db";
import { containers, items } from "@/db/schema";
import { ingestHeartbeat, recordHelperSeen, replaceCalendarEvents } from "@/domain/activity";
import { calendarEvents } from "@/db/schema";
import { addBlock } from "@/domain/blocks";
import { archiveContainer, createContainer } from "@/domain/containers";
import { finishFocus, startFocus } from "@/domain/focus";
import { closeGoal, createGoal, setGoalLinks } from "@/domain/goals";
import { createItem } from "@/domain/items";
import { setMeetingDecision } from "@/domain/meetings/decision";
import { addToPlan } from "@/domain/plan";
import { openReview } from "@/domain/review";
import { completeTask, createTask } from "@/domain/tasks";
import { homePayload } from "./home";

const DATE = "2026-09-22";
/** Mid-morning on the day under test, in the machine's own zone. */
const NOW = new Date(2026, 8, 22, 10, 30, 0);

/** A local wall-clock instant on the day, as the calendar records it. */
function at(hour: number, minute = 0): string {
  return new Date(2026, 8, 22, hour, minute, 0).toISOString();
}

/** The same instant in the local spelling a session's start uses. */
function localAt(hour: number, minute = 0): string {
  return `${DATE}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

describe("homePayload", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  /** Sets a row's `updatedAt` outright: two rows written in the same millisecond cannot order each other. */
  function touchItem(id: number, updatedAt: string): void {
    t.db.update(items).set({ updatedAt }).where(eq(items.id, id)).run();
  }
  function touchContainer(id: number, updatedAt: string): void {
    t.db.update(containers).set({ updatedAt }).where(eq(containers.id, id)).run();
  }

  it("counts the open plan, the day's timed meetings, and the inbox", () => {
    const a = createTask(t.db, { title: "Draft the brief" });
    const b = createTask(t.db, { title: "Book the room" });
    addToPlan(t.db, DATE, a.id);
    addToPlan(t.db, DATE, b.id);
    completeTask(t.db, b.id);
    replaceCalendarEvents(t.db, [
      { externalId: "m1", title: "Product sync", startsAt: at(9), endsAt: at(10), attendees: 3, hasCallLink: true },
      { externalId: "m2", title: "Public holiday", startsAt: at(0), endsAt: at(23, 59), attendees: 0, hasCallLink: false, allDay: true },
    ]);
    const filed = createContainer(t.db, { kind: "project", name: "Launch" });
    createItem(t.db, { type: "note", title: "Loose note" });
    createItem(t.db, { type: "link", title: "Read later", sourceUrl: "https://example.com" });
    createItem(t.db, { type: "note", title: "Filed note", containerId: filed.id });

    const home = homePayload(t.db, NOW);
    expect(home.date).toBe(DATE);
    expect(home.today).toBe(DATE);
    expect(home.counts).toEqual({ planned: 1, meetings: 1, inbox: 2, desk: 0 });
    // The Planner's own day, reused whole rather than rebuilt.
    expect(home.day.date).toBe(DATE);
    expect(home.day.plan.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("puts a meeting in progress before a session in progress, and holds the next two under it", () => {
    const task = createTask(t.db, { title: "Write the spec" });
    const later = createTask(t.db, { title: "Review the spec" });
    addToPlan(t.db, DATE, task.id);
    addToPlan(t.db, DATE, later.id);
    const running = addBlock(t.db, { taskId: task.id, startsAt: localAt(10, 15), minutes: 30 });
    addBlock(t.db, { taskId: later.id, startsAt: localAt(15), minutes: 60 });
    replaceCalendarEvents(t.db, [
      { externalId: "m1", title: "Standup", startsAt: at(10), endsAt: at(11), attendees: 4, hasCallLink: true, joinUrl: "https://meet.example/abc" },
      { externalId: "m2", title: "Design review", startsAt: at(13), endsAt: at(14), attendees: 2, hasCallLink: false },
    ]);

    const home = homePayload(t.db, NOW);
    expect(home.now).toMatchObject({ kind: "meeting", title: "Standup", joinUrl: "https://meet.example/abc" });
    expect(home.now?.meetingId).toBeGreaterThan(0);
    // The session running alongside the meeting has already started, so it is not what comes next.
    expect(home.next.map((i) => [i.kind, i.title])).toEqual([
      ["meeting", "Design review"],
      ["session", "Review the spec"],
    ]);
    expect(home.next.some((i) => i.blockId === running.id)).toBe(false);
  });

  it("never puts a not-going meeting in the Now slot, and shows the session placed in its freed hour instead", () => {
    const task = createTask(t.db, { title: "Write the spec" });
    addToPlan(t.db, DATE, task.id);
    addBlock(t.db, { taskId: task.id, startsAt: localAt(10), minutes: 60 });
    replaceCalendarEvents(t.db, [
      { externalId: "m1", title: "Standup", startsAt: at(10), endsAt: at(11), attendees: 4, hasCallLink: true },
    ]);
    const ev = t.db.select().from(calendarEvents).where(eq(calendarEvents.externalId, "m1")).get()!;
    setMeetingDecision(t.db, ev.id, { decision: "not-going", scope: "occurrence" });

    const home = homePayload(t.db, NOW);
    expect(home.now).toMatchObject({ kind: "session", title: "Write the spec", taskId: task.id });
  });

  it("names a session as now when no meeting is running, and its task and block with it", () => {
    const task = createTask(t.db, { title: "Write the spec" });
    addToPlan(t.db, DATE, task.id);
    const block = addBlock(t.db, { taskId: task.id, startsAt: localAt(10), minutes: 60 });
    const home = homePayload(t.db, NOW);
    expect(home.now).toMatchObject({ kind: "session", title: "Write the spec", taskId: task.id, blockId: block.id });
    expect(home.now?.endsAt).toBe(localAt(11));
    expect(home.next).toEqual([]);
  });

  it("leaves now empty when nothing is on, and skips all-day meetings and finished tasks", () => {
    const done = createTask(t.db, { title: "Already ticked" });
    addToPlan(t.db, DATE, done.id);
    addBlock(t.db, { taskId: done.id, startsAt: localAt(10), minutes: 60 });
    completeTask(t.db, done.id);
    replaceCalendarEvents(t.db, [
      { externalId: "m1", title: "Public holiday", startsAt: at(0), endsAt: at(23, 59), attendees: 0, hasCallLink: false, allDay: true },
    ]);
    const home = homePayload(t.db, NOW);
    expect(home.now).toBeNull();
    expect(home.next).toEqual([]);
  });

  it("credits today's booked minutes to focus, and leaves it at nothing once a run's day is stale", () => {
    const task = createTask(t.db, { title: "Earlier work" });
    const run = startFocus(t.db, { taskId: task.id, minutes: 45 }, new Date(2026, 8, 22, 8, 0, 0));
    finishFocus(t.db, run.id, "completed", new Date(2026, 8, 22, 8, 45, 0));

    const home = homePayload(t.db, NOW);
    expect(home.focus).toEqual({ minutes: 45, running: null });
  });

  it("lets a live run take the Now slot in place of a running session, never in place of a meeting", () => {
    const task = createTask(t.db, { title: "Write the spec" });
    addToPlan(t.db, DATE, task.id);
    const block = addBlock(t.db, { taskId: task.id, startsAt: localAt(10), minutes: 60 });
    const run = startFocus(t.db, { taskId: task.id, blockId: block.id, minutes: 45 }, new Date(2026, 8, 22, 10, 0, 0));

    const withoutMeeting = homePayload(t.db, NOW);
    // The server no longer nulls the session out from under a live run — the client alone
    // decides which of the two wins the Now slot (F3), so Home still has the session to fall
    // back on if the run turns out to be gone by the time this payload is read.
    expect(withoutMeeting.now).toMatchObject({ kind: "session", title: "Write the spec", taskId: task.id });
    expect(withoutMeeting.focus.running).toMatchObject({ id: run.id, taskId: task.id, taskTitle: "Write the spec", plannedMinutes: 45 });

    replaceCalendarEvents(t.db, [{ externalId: "m1", title: "Standup", startsAt: at(10), endsAt: at(11), attendees: 3, hasCallLink: false }]);
    const withMeeting = homePayload(t.db, NOW);
    expect(withMeeting.now).toMatchObject({ kind: "meeting", title: "Standup" });
    // Still reported as running, only not in the Now slot the meeting holds.
    expect(withMeeting.focus.running).toMatchObject({ id: run.id, taskId: task.id });
  });

  it("sorts projects by nearest deadline, then by what was touched last, and stops at six", () => {
    const made: { name: string; id: number }[] = [];
    for (const [name, deadline] of [
      ["Far", "2026-10-01"],
      ["Near", "2026-09-23"],
      ["Undated older", null],
      ["Undated newer", null],
    ] as const) {
      made.push({ name, id: createContainer(t.db, { kind: "project", name, deadline }).id });
    }
    touchContainer(made[2].id, "2026-09-01T09:00:00.000Z");
    touchContainer(made[3].id, "2026-09-20T09:00:00.000Z");
    // The undated pair are in motion on their open work; the sort is what is under test here.
    createTask(t.db, { title: "Keep going", containerId: made[2].id });
    createTask(t.db, { title: "Keep going", containerId: made[3].id });
    // An area and an archived project are not projects in motion.
    createContainer(t.db, { kind: "area", name: "Finance" });
    const shelved = createContainer(t.db, { kind: "project", name: "Shelved" });
    archiveContainer(t.db, shelved.id);

    const first = createTask(t.db, { title: "Pick a date", containerId: made[1].id });
    createTask(t.db, { title: "Send invitations", containerId: made[1].id });
    const shipped = createTask(t.db, { title: "Book the venue", containerId: made[1].id });
    completeTask(t.db, shipped.id);

    const home = homePayload(t.db, NOW);
    expect(home.projects.map((p) => p.name)).toEqual(["Near", "Far", "Undated newer", "Undated older"]);
    expect(home.projects[0]).toMatchObject({ open: 2, done: 1, deadline: "2026-09-23", nextTask: { id: first.id, title: "Pick a date" } });
    expect(home.projects[0].slug).toBe("near");
    expect(home.projects[1].nextTask).toBeNull();

    for (let i = 0; i < 4; i++) createContainer(t.db, { kind: "project", name: `Extra ${i}`, deadline: "2026-09-22" });
    expect(homePayload(t.db, NOW).projects).toHaveLength(6);
  });

  it("keeps a project in motion on its open work, or on a deadline within a fortnight", () => {
    const working = createContainer(t.db, { kind: "project", name: "Working" });
    createTask(t.db, { title: "Still to do", containerId: working.id });
    // Every task ticked off and nothing due: finished work is not motion.
    const finished = createContainer(t.db, { kind: "project", name: "Finished" });
    completeTask(t.db, createTask(t.db, { title: "Shipped", containerId: finished.id }).id);
    createContainer(t.db, { kind: "project", name: "Empty" });
    createContainer(t.db, { kind: "project", name: "Someday", deadline: "2026-12-01" });
    // Nothing open, but the date is close enough that having nothing open is the news.
    createContainer(t.db, { kind: "project", name: "Due soon", deadline: "2026-10-05" });
    createContainer(t.db, { kind: "project", name: "Overdue", deadline: "2026-09-01" });

    const shown = homePayload(t.db, NOW).projects;
    expect(shown.map((p) => p.name)).toEqual(["Overdue", "Due soon", "Working"]);
    expect(shown.find((p) => p.name === "Due soon")).toMatchObject({ open: 0, done: 0, deadline: "2026-10-05", nextTask: null });
  });

  it("lists the last five items touched, newest first, with a meeting's own chip state", () => {
    const made = ["One", "Two", "Three", "Four", "Five", "Six"].map((title) => createItem(t.db, { type: "note", title }));
    made.forEach((item, i) => touchItem(item.id, `2026-09-${String(10 + i).padStart(2, "0")}T09:00:00.000Z`));
    const meeting = createItem(t.db, { type: "meeting", title: "Product sync", meta: { transcript: "files/a.txt" } });
    touchItem(meeting.id, "2026-09-21T09:00:00.000Z");

    const home = homePayload(t.db, NOW);
    expect(home.recent.map((r) => r.title)).toEqual(["Product sync", "Six", "Five", "Four", "Three"]);
    expect(home.recent[0]).toMatchObject({ type: "meeting", status: "pending", meeting: { hasTranscript: true, hasSummary: false } });
    // Only a meeting item carries the chip.
    expect(home.recent[1].meeting).toBeUndefined();
  });

  it("stamps the instant it was built, so a relative time reads the same on both sides", () => {
    const home = homePayload(t.db, NOW);
    expect(home.generatedAt).toBe(NOW.toISOString());
  });

  it("reports the day's activity only once the helper has been seen", () => {
    const S = new Date(2026, 8, 22, 9, 0, 0).getTime();
    const stamp = (s: number) => new Date(S + s * 1000).toISOString();
    ingestHeartbeat(t.db, { at: stamp(0), appId: "com.microsoft.VSCode", appName: "Code", title: null, url: null });
    ingestHeartbeat(t.db, { at: stamp(600), appId: "com.microsoft.VSCode", appName: "Code", title: null, url: null });
    ingestHeartbeat(t.db, { at: stamp(605), appId: "com.google.Chrome", appName: "Chrome", title: "GitHub", url: "https://github.com/x" });
    ingestHeartbeat(t.db, { at: stamp(905), appId: "com.google.Chrome", appName: "Chrome", title: "GitHub", url: "https://github.com/x" });

    expect(homePayload(t.db, NOW).activity).toBeNull();

    recordHelperSeen(t.db, NOW.toISOString());
    const activity = homePayload(t.db, NOW).activity;
    expect(activity?.activeMs).toBe(605_000 + 300_000);
    // One line per app, longest first: the browser is named by the site it spent its time on,
    // so the same five minutes are never counted twice.
    expect(activity?.top).toHaveLength(2);
    expect(activity?.top.map((x) => x.label)).toEqual(["Code", "github.com"]);
    expect(activity?.top[1].ms).toBe(300_000);
    expect(activity?.top.reduce((n, x) => n + x.ms, 0)).toBe(activity?.activeMs);
  });

  it("names an app by itself when its time is not mostly on the web", () => {
    const S = new Date(2026, 8, 22, 9, 0, 0).getTime();
    const stamp = (s: number) => new Date(S + s * 1000).toISOString();
    // Ten minutes in the editor, one of them reading a page inside it.
    ingestHeartbeat(t.db, { at: stamp(0), appId: "com.microsoft.VSCode", appName: "Code", title: null, url: null });
    ingestHeartbeat(t.db, { at: stamp(540), appId: "com.microsoft.VSCode", appName: "Code", title: null, url: null });
    ingestHeartbeat(t.db, { at: stamp(545), appId: "com.microsoft.VSCode", appName: "Code", title: "Docs", url: "https://docs.example.com/a" });
    ingestHeartbeat(t.db, { at: stamp(605), appId: "com.microsoft.VSCode", appName: "Code", title: "Docs", url: "https://docs.example.com/a" });
    recordHelperSeen(t.db, NOW.toISOString());
    expect(homePayload(t.db, NOW).activity?.top.map((x) => x.label)).toEqual(["Code"]);
  });

  describe("review", () => {
    it("does not ask for a review before Friday", () => {
      const wednesday = new Date(2026, 8, 23, 10, 0, 0);
      expect(homePayload(t.db, wednesday).review).toEqual({ due: false });
    });

    it("asks from Friday when the week has no review", () => {
      const friday = new Date(2026, 8, 25, 10, 0, 0);
      expect(homePayload(t.db, friday).review).toEqual({ due: true });
    });

    it("stops asking once the week has one", () => {
      const friday = new Date(2026, 8, 25, 10, 0, 0);
      openReview(t.db, "2026-09-21");
      expect(homePayload(t.db, friday).review).toEqual({ due: false });
    });
  });

  describe("this week's meeting load", () => {
    it("reads the same figure the audit page's own weeklyMeetingShare computes", () => {
      replaceCalendarEvents(t.db, [
        { externalId: "standup", title: "Standup", startsAt: localAt(10), endsAt: localAt(10, 30), attendees: 3, hasCallLink: false },
      ]);
      // The week's own Monday, so the meeting lands inside it regardless of which weekday NOW is.
      expect(homePayload(t.db, NOW).meetingShare.minutes).toBeGreaterThan(0);
    });

    it("reports nothing rather than a zero-minute meeting week", () => {
      expect(homePayload(t.db, NOW).meetingShare).toEqual({ minutes: 0, workingMinutes: expect.any(Number) });
    });
  });

  describe("stalled goals", () => {
    it("names an active goal with no linked work at all -- stalled by definition", () => {
      const goal = createGoal(t.db, { title: "Ship the docs", horizon: "quarter", targetDate: "2026-12-31" });
      expect(homePayload(t.db, NOW).stalledGoals).toEqual([{ id: goal.id, title: "Ship the docs" }]);
    });

    it("leaves out a goal with something closed against it recently", () => {
      const goal = createGoal(t.db, { title: "Launch v2", horizon: "quarter", targetDate: "2026-12-31" });
      const container = createContainer(t.db, { kind: "project", name: "Launch" });
      setGoalLinks(t.db, goal.id, [container.id]);
      const task = createTask(t.db, { title: "Ship it", containerId: container.id });
      completeTask(t.db, task.id);
      expect(homePayload(t.db, NOW).stalledGoals).toEqual([]);
    });

    it("leaves out a closed goal even with nothing linked", () => {
      const goal = createGoal(t.db, { title: "Old goal", horizon: "quarter", targetDate: "2026-01-01" });
      closeGoal(t.db, goal.id, "dropped");
      expect(homePayload(t.db, NOW).stalledGoals).toEqual([]);
    });
  });

  describe("the payload describes one moment", () => {
    it("measures the day's remaining time against the clock it was given, not the wall clock", () => {
      // The whole payload is a picture of `now`. `plannerDay` has its own `now` defaulting to
      // the real clock, so leaving it out shipped a `generatedAt` from the argument beside a
      // capacity from whenever the request happened to run.
      const morning = new Date(2026, 8, 22, 10, 30, 0);
      const evening = new Date(2026, 8, 22, 17, 30, 0);
      const hours = homePayload(t.db, morning).day.capacity.leftTodayMinutes;
      const later = homePayload(t.db, evening).day.capacity.leftTodayMinutes;
      // 09:00-18:00 by default: seven and a half hours left at half past ten, half an hour at
      // half past five. The point is that the two differ and both follow the argument.
      expect(hours).toBe(450);
      expect(later).toBe(30);
    });

    it("reads a future day as the whole working window whatever time it is now", () => {
      const lateTonight = new Date(2026, 8, 22, 23, 0, 0);
      const home = homePayload(t.db, lateTonight);
      // Today is over, so today's own figure is nothing left.
      expect(home.day.capacity.leftTodayMinutes).toBe(0);
    });
  });
});
