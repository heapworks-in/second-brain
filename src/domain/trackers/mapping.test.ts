import { describe, it, expect } from "vitest";
import { guessMapping, guessStatus, guessStatusMap, parseEta, statusWords } from "./mapping";

describe("guessMapping", () => {
  it("reads the columns a real tracker has", () => {
    expect(guessMapping(["Theme", "Task", "Sub task", "Owner", "ETA", "Team", "Comments", "Status"])).toEqual({
      theme: "Theme",
      task: "Task",
      subTask: "Sub task",
      owner: "Owner",
      eta: "ETA",
      team: "Team",
      comments: "Comments",
      status: "Status",
    });
  });

  /** The one that breaks a naive pass: "task" matches "Sub-task" too, and claiming it for `task`
   * leaves every sub-task in the file unmapped. */
  it("gives Sub-task to subTask and leaves Task to task, whatever order the columns are in", () => {
    const m = guessMapping(["Sub-task", "Task"]);
    expect(m.subTask).toBe("Sub-task");
    expect(m.task).toBe("Task");
  });

  it("finds a field inside a longer header, but never inside another word", () => {
    expect(guessMapping(["Target ETA (IST)"]).eta).toBe("Target ETA (IST)");
    // "Status" is a word here; "Statuses of tasks" would be too. "Taskmaster" is not "task".
    expect(guessMapping(["Taskmaster"]).task).toBeUndefined();
  });

  it("claims each header once, so two fields never read the same column", () => {
    const m = guessMapping(["Activity", "Assigned to", "Notes"]);
    expect([m.task, m.owner, m.comments]).toEqual(["Activity", "Assigned to", "Notes"]);
  });

  it("says nothing about columns it does not recognise", () => {
    expect(guessMapping(["Risk level", "Jira", "Phase 2?"])).toEqual({});
  });
});

describe("guessStatus", () => {
  it("knows the two ends of the lifecycle, in the words sheets use", () => {
    for (const word of ["Done", "DONE", "Completed", "Closed", "Shipped", "Delivered"]) expect(guessStatus(word)).toBe("done");
    for (const word of ["Cancelled", "Dropped", "Won't do", "De-scoped"]) expect(guessStatus(word)).toBe("dropped");
  });

  /** The important half: these are open, and the word itself is what the team reads. Guessing
   * "Blocked" into anything would either hide the row or mark work finished that is not. */
  it("has no opinion about the middle, which is where most of a tracker lives", () => {
    for (const word of ["In Progress", "Blocked", "On Hold", "Not started", "WIP", "Yet to start", ""]) {
      expect(guessStatus(word)).toBeNull();
    }
  });

  it("maps only the words it is sure of, leaving the rest for the preview to ask about", () => {
    const words = statusWords([{ S: "Done" }, { S: "Blocked" }, { S: "done" }, { S: "" }, { S: "In Progress" }], "S");
    expect(words).toEqual(["Done", "Blocked", "In Progress"]);
    expect(guessStatusMap(words)).toEqual({ Done: "done" });
  });
});

describe("parseEta", () => {
  it("takes ISO and day-first dates", () => {
    expect(parseEta("2026-11-12")).toBe("2026-11-12");
    expect(parseEta("2026-11-12T00:00:00.000Z")).toBe("2026-11-12");
    expect(parseEta("12/11/2026")).toBe("2026-11-12");
    expect(parseEta("12-11-26")).toBe("2026-11-12");
    expect(parseEta("3.4.2026")).toBe("2026-04-03");
  });

  it("leaves prose alone rather than inventing a deadline", () => {
    for (const text of ["mid Nov", "W47", "after the audit", "TBD", "", "Q3"]) expect(parseEta(text)).toBeNull();
  });

  it("refuses a date that does not exist", () => {
    expect(parseEta("31/02/2026")).toBeNull();
    expect(parseEta("12/13/2026")).toBeNull();
  });
});
