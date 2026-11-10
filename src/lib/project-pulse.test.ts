import { describe, expect, it } from "vitest";
import type { TaskDTO } from "@/lib/dto";
import { hasPulse, projectPulse } from "./project-pulse";

const TODAY = "2026-10-17";

function task(over: Partial<TaskDTO> = {}): TaskDTO {
  return {
    id: 1,
    title: "A task",
    notes: "",
    status: "open",
    priority: "normal",
    dueDate: null,
    containerId: 1,
    sourceItemId: null, requester: null, askedOn: null,
    estimateMinutes: null,
    sessionMinutes: null,
    blocks: [],
    goals: [],
    spentMinutes: 0,
    likeThisMinutes: null,
    completedAt: null,
    sortOrder: 0,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("projectPulse", () => {
  it("counts the open work, and what of it cannot be forecast", () => {
    const p = projectPulse([task({ id: 1, estimateMinutes: 60 }), task({ id: 2 }), task({ id: 3 })], TODAY);
    expect(p.open).toBe(3);
    expect(p.unestimated).toBe(2);
  });

  /** The list is ordered by hand, so an overdue task can sit anywhere in it. */
  it("counts overdue open tasks, and does not call due-today overdue", () => {
    const p = projectPulse(
      [
        task({ id: 1, dueDate: "2026-10-16" }),
        task({ id: 2, dueDate: TODAY }),
        task({ id: 3, dueDate: "2026-10-20" }),
        // A closed task that was late is not an overdue task any more.
        task({ id: 4, status: "done", dueDate: "2026-10-01", completedAt: "2026-10-02T09:00:00.000Z" }),
      ],
      TODAY,
    );
    expect(p.overdue).toBe(1);
  });

  /** A project's cost is what it has taken, so closing work must not make "spent" shrink. */
  it("sums estimate and spend across closed work too", () => {
    const p = projectPulse(
      [
        task({ id: 1, estimateMinutes: 60, spentMinutes: 90 }),
        task({ id: 2, status: "done", estimateMinutes: 30, spentMinutes: 45, completedAt: "2026-10-15T09:00:00.000Z" }),
      ],
      TODAY,
    );
    expect(p.estimatedMinutes).toBe(90);
    expect(p.spentMinutes).toBe(135);
  });

  it("counts what closed in the last week, by when it closed", () => {
    const p = projectPulse(
      [
        task({ id: 1, status: "done", completedAt: "2026-10-16T09:00:00.000Z" }),
        task({ id: 2, status: "done", completedAt: "2026-10-11T09:00:00.000Z" }),
        // Eight days ago: outside the window.
        task({ id: 3, status: "done", completedAt: "2026-10-09T09:00:00.000Z" }),
        // Closed, but the date was never recorded.
        task({ id: 4, status: "done", completedAt: null }),
      ],
      TODAY,
    );
    expect(p.closedRecently).toBe(2);
  });

  it("is all zeroes for a project with no tasks", () => {
    expect(projectPulse([], TODAY)).toEqual({ open: 0, overdue: 0, unestimated: 0, estimatedMinutes: 0, spentMinutes: 0, closedRecently: 0 });
  });
});

describe("hasPulse", () => {
  it("is false when there is nothing measured to show", () => {
    expect(hasPulse(projectPulse([], TODAY))).toBe(false);
    // Dropped tasks are not work in flight and not work done.
    expect(hasPulse(projectPulse([task({ status: "dropped" })], TODAY))).toBe(false);
  });

  it("is true on open work, on recent closes, or on time already spent", () => {
    expect(hasPulse(projectPulse([task({})], TODAY))).toBe(true);
    expect(hasPulse(projectPulse([task({ status: "done", completedAt: "2026-10-16T09:00:00.000Z" })], TODAY))).toBe(true);
    expect(hasPulse(projectPulse([task({ status: "done", spentMinutes: 30, completedAt: null })], TODAY))).toBe(true);
  });
});
