import { describe, it, expect } from "vitest";
import { quickParse } from "./quick-parse";

const now = new Date(2026, 8, 16, 10, 0, 0); // Wednesday 16 September 2026, local

describe("quickParse", () => {
  it("returns the title untouched when nothing matches", () => {
    expect(quickParse("Draft welcome email", now)).toEqual({ title: "Draft welcome email", priority: "normal", dueDate: null, estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
  });
  it("reads a leading or trailing ! as high priority", () => {
    expect(quickParse("! Call the bank", now)).toEqual({ title: "Call the bank", priority: "high", dueDate: null, estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
    expect(quickParse("Call the bank!", now)).toEqual({ title: "Call the bank", priority: "high", dueDate: null, estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
  });
  it("reads today, tomorrow, weekday names, and ISO dates as the due date", () => {
    expect(quickParse("Pay rent today", now).dueDate).toBe("2026-09-16");
    expect(quickParse("Pay rent tomorrow", now).dueDate).toBe("2026-09-17");
    expect(quickParse("Ship it fri", now)).toEqual({ title: "Ship it", priority: "normal", dueDate: "2026-09-18", estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
    expect(quickParse("Ship it Wednesday", now).dueDate).toBe("2026-09-16");
    expect(quickParse("Ship it tue", now).dueDate).toBe("2026-09-22");
    expect(quickParse("Ship it 2026-10-01", now)).toEqual({ title: "Ship it", priority: "normal", dueDate: "2026-10-01", estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
  });
  it("combines priority and date and trims whitespace", () => {
    expect(quickParse("  Collect 1099 forms fri !  ", now)).toEqual({ title: "Collect 1099 forms", priority: "high", dueDate: "2026-09-18", estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
  });
  it("does not eat a word that only looks like a day", () => {
    expect(quickParse("Read Monday's notes", now)).toEqual({ title: "Read Monday's notes", priority: "normal", dueDate: null, estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
    expect(quickParse("fri", now)).toEqual({ title: "fri", priority: "normal", dueDate: null, estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
  });

  it("reads a trailing ~ estimate in minutes or hours and strips it from the title", () => {
    const now = new Date("2026-09-23T09:00:00");
    expect(quickParse("Write the note ~25m", now)).toMatchObject({ title: "Write the note", estimateMinutes: 25 });
    expect(quickParse("Deep work ~1h", now)).toMatchObject({ title: "Deep work", estimateMinutes: 60 });
    expect(quickParse("Deep work ~1h30m", now)).toMatchObject({ title: "Deep work", estimateMinutes: 90 });
    expect(quickParse("Call Ada tomorrow ~15m", now)).toMatchObject({ title: "Call Ada", estimateMinutes: 15 });
    expect(quickParse("Call Ada ~15m tomorrow", now)).toMatchObject({ title: "Call Ada", estimateMinutes: 15 });
    expect(quickParse("Tilde ~ alone", now)).toMatchObject({ title: "Tilde ~ alone", estimateMinutes: null });
    expect(quickParse("Too long ~9h", now)).toMatchObject({ title: "Too long ~9h", estimateMinutes: null });
    expect(quickParse("Plain", now).estimateMinutes).toBeNull();
  });

  it("reads a session length after the estimate as ~2h/45m", () => {
    const now = new Date("2026-09-23T09:00:00");
    expect(quickParse("Deep work ~2h/45m", now)).toMatchObject({ title: "Deep work", estimateMinutes: 120, sessionMinutes: 45 });
    expect(quickParse("Sprint ~90m/30m", now)).toMatchObject({ title: "Sprint", estimateMinutes: 90, sessionMinutes: 30 });
    expect(quickParse("Sprint ~2h/1h", now)).toMatchObject({ title: "Sprint", estimateMinutes: 120, sessionMinutes: 60 });
    // Hours and minutes together on the session side, the same way the estimate reads them.
    expect(quickParse("Sprint ~2h/1h20m", now)).toMatchObject({ title: "Sprint", estimateMinutes: 120, sessionMinutes: 80 });
  });
  it("reads a dangling slash as no session length at all", () => {
    const now = new Date("2026-09-23T09:00:00");
    // Mid-typing, "~2h/" is still "~2h": the estimate stands, the slash goes with the token
    // rather than being left in the title.
    expect(quickParse("Deep work ~2h/", now)).toMatchObject({ title: "Deep work", estimateMinutes: 120, sessionMinutes: null });
  });
  it("ignores a session length under the 15-minute floor, keeping the estimate", () => {
    const now = new Date("2026-09-23T09:00:00");
    expect(quickParse("Deep work ~2h/9m", now)).toMatchObject({ title: "Deep work", estimateMinutes: 120, sessionMinutes: null });
  });
  it("ignores a session length that is not strictly under the estimate", () => {
    const now = new Date("2026-09-23T09:00:00");
    expect(quickParse("Deep work ~45m/60m", now)).toMatchObject({ title: "Deep work", estimateMinutes: 45, sessionMinutes: null });
    expect(quickParse("Deep work ~45m/45m", now)).toMatchObject({ title: "Deep work", estimateMinutes: 45, sessionMinutes: null });
  });
  it("reads the first @handle as who is waiting, and leaves it in the title", () => {
    const now = new Date("2026-09-23T09:00:00");
    // The handle stays put: unresolvable text the user typed is still text they can see, which
    // is exactly how an item's body treats a mention.
    expect(quickParse("@priya unblock the schema review", now)).toMatchObject({ title: "@priya unblock the schema review", requesterHandle: "priya" });
    // One requester, so the first handle wins and the second is just words.
    expect(quickParse("ask @priya and @sam", now)).toMatchObject({ requesterHandle: "priya" });
    expect(quickParse("Write the brief fri", now)).toMatchObject({ title: "Write the brief", requesterHandle: null });
  });

  it("does not read an email address as a handle", () => {
    const now = new Date("2026-09-23T09:00:00");
    expect(quickParse("Reply to priya@example.com", now)).toMatchObject({ requesterHandle: null });
  });

  it("reads a handle alongside the other shortcuts", () => {
    const now = new Date("2026-09-23T09:00:00");
    expect(quickParse("! @priya review the plan ~30m fri", now)).toMatchObject({
      title: "@priya review the plan",
      priority: "high",
      dueDate: "2026-09-25",
      estimateMinutes: 30,
      requesterHandle: "priya",
    });
  });
});
