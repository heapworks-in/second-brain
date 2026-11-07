// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { TaskRow } from "./task-row";
import type { TaskDTO } from "@/lib/dto";

// See task-list.test.tsx: this vitest config has no global `afterEach`, so
// @testing-library/react's auto-cleanup never registers and a mounted row's window
// keydown/mousedown listeners would otherwise outlive this test.
afterEach(cleanup);

const task: TaskDTO = {
  id: 1, title: "Draft email", notes: "", status: "open", priority: "normal", dueDate: null, containerId: 5, sourceItemId: null,
  estimateMinutes: null, sessionMinutes: null, blocks: [], goals: [], spentMinutes: 0, likeThisMinutes: null, completedAt: null, sortOrder: 0, createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
};

interface ExtraProps {
  onPlan?: () => void;
  onBlockNow?: () => void;
  onUnblock?: () => void;
  onPlace?: () => void;
  onSplit?: (minutes: number | null) => void;
  blockDate?: string;
  onEstimate?: (minutes: number | null) => void;
  onPlanDate?: (date: string) => void;
  planFrom?: string;
  planLabel?: string;
  planned?: boolean;
  compact?: boolean;
}

function renderRow(extra: ExtraProps = {}, row: TaskDTO = task) {
  const handlers = {
    onToggle: vi.fn(),
    onRename: vi.fn(),
    onDue: vi.fn(),
    onPriority: vi.fn(),
    onDrop: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
  };
  render(
    <ul role="list">
      <TaskRow task={row} today="2026-09-16" {...handlers} {...extra} />
    </ul>,
  );
  return handlers;
}

/** The portalled menu panel, which lives outside the row's own DOM subtree. */
function openMenuPanel(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
  return screen.getByRole("menu");
}

function openMenu(): HTMLElement {
  const trigger = screen.getByRole("button", { name: "Task actions" });
  fireEvent.click(trigger);
  return trigger;
}

describe("TaskRow actions menu", () => {
  it("opens on the trigger with keyboard access: menu items, initial focus, Escape, and actions", () => {
    const handlers = renderRow();
    const trigger = screen.getByRole("button", { name: "Task actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Rename", "Set due date", "Move up", "Move down", "Drop", "Delete"]);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(handlers.onMove).toHaveBeenCalledWith("up");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("TaskRow planning", () => {
  it("plans for today and closes the menu", () => {
    const onPlan = vi.fn();
    renderRow({ onPlan });
    const trigger = openMenu();
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Rename", "Set due date", "Plan for today", "Move up", "Move down", "Drop", "Delete",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Plan for today" }));
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("offers to take an already planned task back off the plan", () => {
    const onPlan = vi.fn();
    renderRow({ onPlan, planned: true });
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Plan for today" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from plan" }));
    expect(onPlan).toHaveBeenCalledTimes(1);
  });

  it("opens the next seven days when a date can be chosen", () => {
    const onPlanDate = vi.fn();
    renderRow({ onPlanDate });
    const trigger = openMenu();
    const planFor = screen.getByRole("menuitem", { name: "Plan for" });
    expect(planFor.getAttribute("aria-haspopup")).toBe("menu");
    expect(planFor.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(planFor);
    expect(planFor.getAttribute("aria-expanded")).toBe("true");
    const days = screen.getByRole("menu", { name: "Plan for" });
    expect(Array.from(days.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent)).toEqual([
      "Today 16", "Thursday 17", "Friday 18", "Saturday 19", "Sunday 20", "Monday 21", "Tuesday 22",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Friday 18" }));
    expect(onPlanDate).toHaveBeenCalledWith("2026-09-18");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("offers the week on screen, not this one, when the days start elsewhere", () => {
    const onPlanDate = vi.fn();
    renderRow({ onPlanDate, planFrom: "2026-10-05" });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Plan for" }));
    const days = screen.getByRole("menu", { name: "Plan for" });
    // No "Today": today is three weeks behind the week being shown.
    expect(Array.from(days.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent)).toEqual([
      "Monday 5", "Tuesday 6", "Wednesday 7", "Thursday 8", "Friday 9", "Saturday 10", "Sunday 11",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Wednesday 7" }));
    expect(onPlanDate).toHaveBeenCalledWith("2026-10-07");
  });

  it("names the single plan item after the day the view is showing", () => {
    renderRow({ onPlan: vi.fn(), planLabel: "Plan for this day" });
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Plan for this day" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Plan for today" })).toBeNull();
  });

  it("escape closes the day list first and leaves the menu open", () => {
    renderRow({ onPlanDate: vi.fn() });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Plan for" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Plan for" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("TaskRow compact", () => {
  it("keeps the title and the menu in a week column's width", () => {
    renderRow({ compact: true }, { ...task, dueDate: "2026-09-18" });
    const title = screen.getByRole("button", { name: "Draft email" });
    expect(title.className).toContain("line-clamp-2");
    expect(screen.getByRole("button", { name: "Task actions" })).toBeTruthy();
    // The due date moves under the title, still in mono; the priority chip is dropped.
    expect(screen.getByRole("button", { name: "Fri 18" }).className).toContain("font-mono");
    expect(screen.queryByText("High")).toBeNull();
  });
});

describe("TaskRow goal", () => {
  it("names the goal its container serves, faintly and linked to the goal", () => {
    renderRow({}, { ...task, goals: [{ id: 3, title: "Launch v2" }] });
    const chip = screen.getByRole("link", { name: "Launch v2" });
    expect(chip.getAttribute("href")).toBe("/goals/3");
    expect(chip.className).toContain("text-fg-faint");
  });

  it("shows the first goal and a count for the rest", () => {
    renderRow({}, { ...task, goals: [{ id: 3, title: "Launch v2" }, { id: 4, title: "Ship the API" }] });
    const chip = screen.getByRole("link", { name: "Launch v2+1" });
    expect(chip.getAttribute("href")).toBe("/goals/3");
    expect(screen.queryByText("Ship the API")).toBeNull();
  });

  it("renders exactly as it does today when the task has no goal", () => {
    renderRow({}, task);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("TaskRow estimate", () => {
  it("shows the estimate, offers presets and a free field, and clears", () => {
    const onEstimate = vi.fn();
    renderRow({ onEstimate }, { ...task, estimateMinutes: 90 });
    const chip = screen.getByRole("button", { name: "Estimate 1h 30m" });
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "25m" }));
    expect(onEstimate).toHaveBeenLastCalledWith(25);
    fireEvent.click(screen.getByRole("button", { name: "Estimate 1h 30m" }));
    const field = screen.getByRole("spinbutton", { name: "Minutes" });
    fireEvent.change(field, { target: { value: "50" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onEstimate).toHaveBeenLastCalledWith(50);
    fireEvent.click(screen.getByRole("button", { name: "Estimate 1h 30m" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "No estimate" }));
    expect(onEstimate).toHaveBeenLastCalledWith(null);
  });

  it("leaves the estimate alone on Escape, from the field or from the chip", () => {
    const onEstimate = vi.fn();
    renderRow({ onEstimate }, { ...task, estimateMinutes: 90 });
    const chip = screen.getByRole("button", { name: "Estimate 1h 30m" });
    fireEvent.click(chip);
    const field = screen.getByRole("spinbutton", { name: "Minutes" });
    fireEvent.change(field, { target: { value: "50" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onEstimate).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "Estimate" })).toBeNull();
    expect(document.activeElement).toBe(chip);

    // Escape reaches the wrapper from the trigger too, not only from inside the panel.
    fireEvent.click(chip);
    expect(screen.getByRole("menu", { name: "Estimate" })).toBeTruthy();
    fireEvent.keyDown(chip, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Estimate" })).toBeNull();
    expect(onEstimate).not.toHaveBeenCalled();
  });

  it("says what the field will take rather than swallowing an impossible number", () => {
    const onEstimate = vi.fn();
    renderRow({ onEstimate }, { ...task, estimateMinutes: null });
    fireEvent.click(screen.getByRole("button", { name: "Estimate: none" }));
    const field = screen.getByRole("spinbutton", { name: "Minutes" });
    fireEvent.change(field, { target: { value: "900" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onEstimate).not.toHaveBeenCalled();
    expect(screen.getByText("Between 5 and 480 minutes")).toBeTruthy();
    // Typing again clears the complaint, and a sane number still commits.
    fireEvent.change(field, { target: { value: "45" } });
    expect(screen.queryByText("Between 5 and 480 minutes")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onEstimate).toHaveBeenCalledWith(45);
  });

  it("reads est when there is none, and hides without a handler", () => {
    renderRow({ onEstimate: vi.fn() }, { ...task, estimateMinutes: null });
    expect(screen.getByRole("button", { name: "Estimate: none" }).textContent).toBe("est");
    cleanup();
    renderRow({}, { ...task, estimateMinutes: 30 });
    expect(screen.queryByRole("button", { name: /Estimate/ })).toBeNull();
  });
});

describe("TaskRow spent", () => {
  it("says nothing about what a task cost until a run has landed against it", () => {
    renderRow({}, { ...task, estimateMinutes: 45, spentMinutes: 0 });
    expect(screen.queryByText(/[Ss]pent/)).toBeNull();
  });

  it("reads what the task cost once a run has, and offers to correct a stale estimate", () => {
    renderRow({}, { ...task, estimateMinutes: 45, spentMinutes: 80 });
    expect(screen.getByText("Estimated 45m, spent 1h 20m")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use 1h 20m as the estimate" })).toBeTruthy();
  });

  it("shows the same line in the compact row", () => {
    renderRow({ compact: true }, { ...task, estimateMinutes: 45, spentMinutes: 80 });
    expect(screen.getByText("Estimated 45m, spent 1h 20m")).toBeTruthy();
  });

  // Concern A: SpentLine and EstimateHint both write `estimateMinutes`. Only one offer may
  // stand on a row, and it is the outside view's (the hint's), never the partial inside figure —
  // see the three states below.
  it("lets the outside-view hint's offer win over the spent line's own, but keeps the spent fact", () => {
    const onEstimate = vi.fn();
    renderRow({ onEstimate }, { ...task, estimateMinutes: null, spentMinutes: 20, likeThisMinutes: 50 });
    expect(screen.getByText("Spent 20m")).toBeTruthy();
    expect(screen.getByText("Tasks like this have taken about 50m")).toBeTruthy();
    const offers = screen.getAllByRole("button", { name: /as the estimate/ });
    expect(offers).toHaveLength(1);
    expect(offers[0].textContent).toBe("Use 50m as the estimate");
  });

  it("keeps the spent line's own offer when there is no outside-view hint to replace it", () => {
    const onEstimate = vi.fn();
    renderRow({ onEstimate }, { ...task, estimateMinutes: null, spentMinutes: 20, likeThisMinutes: null });
    expect(screen.getByText("Spent 20m")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use 20m as the estimate" })).toBeTruthy();
    expect(screen.queryByText(/Tasks like this/)).toBeNull();
  });
});

describe("TaskRow estimate hint", () => {
  it("says nothing on an open task that already has an estimate", () => {
    renderRow({ onEstimate: vi.fn() }, { ...task, estimateMinutes: 45, likeThisMinutes: 50 });
    expect(screen.queryByText(/Tasks like this/)).toBeNull();
  });

  it("says nothing on a done task", () => {
    renderRow({ onEstimate: vi.fn() }, { ...task, status: "done", estimateMinutes: null, likeThisMinutes: 50 });
    expect(screen.queryByText(/Tasks like this/)).toBeNull();
  });

  it("says nothing with fewer than three matches to hint from", () => {
    renderRow({ onEstimate: vi.fn() }, { ...task, estimateMinutes: null, likeThisMinutes: null });
    expect(screen.queryByText(/Tasks like this/)).toBeNull();
  });

  it("says nothing on a task with no container", () => {
    renderRow({ onEstimate: vi.fn() }, { ...task, containerId: null, estimateMinutes: null, likeThisMinutes: null });
    expect(screen.queryByText(/Tasks like this/)).toBeNull();
  });

  it("says nothing without a way to save the estimate, even with a real figure to offer", () => {
    renderRow({}, { ...task, estimateMinutes: null, likeThisMinutes: 50 });
    expect(screen.queryByText(/Tasks like this/)).toBeNull();
  });

  it("offers the figure and sets it on click, on an open task with no estimate and enough matches", () => {
    const onEstimate = vi.fn();
    renderRow({ onEstimate }, { ...task, estimateMinutes: null, likeThisMinutes: 50 });
    expect(screen.getByText("Tasks like this have taken about 50m")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use 50m as the estimate" }));
    expect(onEstimate).toHaveBeenCalledWith(50);
  });

  it("shows the same hint in the compact row", () => {
    renderRow({ compact: true, onEstimate: vi.fn() }, { ...task, estimateMinutes: null, likeThisMinutes: 50 });
    expect(screen.getByText("Tasks like this have taken about 50m")).toBeTruthy();
  });

  it("leaves the row byte-identical whether or not there is a figure to withhold", () => {
    // An estimated task with spent minutes already booked — the hint has nothing to say about
    // it regardless of what `likeThisMinutes` carries, so the row's own markup must not move a
    // pixel for it: no empty wrapper, no spacing change, whatever the field holds.
    renderRow({ onEstimate: vi.fn() }, { ...task, estimateMinutes: 45, spentMinutes: 80, likeThisMinutes: null });
    const before = screen.getByRole("list").innerHTML;
    cleanup();
    renderRow({ onEstimate: vi.fn() }, { ...task, estimateMinutes: 45, spentMinutes: 80, likeThisMinutes: 200 });
    expect(screen.getByRole("list").innerHTML).toBe(before);
  });

  it("adds no empty wrapper on an estimated task with nothing spent, even with a way to save an estimate (F3)", () => {
    // Neither line has anything to show: the task is already estimated (so the hint is gated
    // off by `hasEstimateHint`, regardless of `likeThisMinutes`) and nothing has been spent yet
    // (so `SpentLine` renders null). A mutant that drops the `hasEstimateHint` gate still leaves
    // `EstimateHint` itself rendering null internally, but the row's own `estimateHint` variable
    // becomes a truthy element anyway — which flips `extraLine` truthy and adds an empty `pl-9`
    // wrapper div plus a spacing change, exactly the regression this row's comment above claims
    // is prevented. `spentMinutes: 0` is what makes that difference visible: with spent minutes
    // present (as the test above still carries), the wrapper is not empty either way.
    renderRow({ onEstimate: vi.fn() }, { ...task, estimateMinutes: 45, spentMinutes: 0, likeThisMinutes: 200 });
    const list = screen.getByRole("list");
    expect(list.querySelector(".pl-9")).toBeNull();
    expect(list.querySelector(".hairline-row")?.className).toContain("h-11 justify-center");
    expect(list.querySelector(".hairline-row")?.className).not.toContain("py-2");
  });
});

describe("TaskRow keyboard planning", () => {
  it("plans on p from the title, unplans when already planned, and says so", () => {
    const onPlan = vi.fn();
    const toasts: unknown[] = [];
    const listen = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener("sb:toast", listen);
    try {
      renderRow({ onPlan }, { ...task, title: "Write" });
      const title = screen.getByRole("button", { name: "Write" });
      title.focus();
      fireEvent.keyDown(title, { key: "p" });
      expect(onPlan).toHaveBeenCalledTimes(1);
      expect(toasts).toEqual([{ text: "Planned for today" }]);
      cleanup();
      renderRow({ onPlan, planned: true }, { ...task, title: "Write" });
      fireEvent.keyDown(screen.getByRole("button", { name: "Write" }), { key: "p" });
      expect(toasts[1]).toEqual({ text: "Taken off the plan" });
    } finally {
      window.removeEventListener("sb:toast", listen);
    }
  });

  it("plans for the first offered day when the day is the caller's to choose, and names it", () => {
    const onPlanDate = vi.fn();
    const toasts: unknown[] = [];
    const listen = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener("sb:toast", listen);
    try {
      renderRow({ onPlanDate, planFrom: "2026-09-25" }, { ...task, title: "Write" });
      fireEvent.keyDown(screen.getByRole("button", { name: "Write" }), { key: "p" });
      expect(onPlanDate).toHaveBeenCalledWith("2026-09-25");
      // The day is said the way the row says every other date, not as a raw ISO string.
      expect(toasts).toEqual([{ text: "Planned for Fri 25" }]);
    } finally {
      window.removeEventListener("sb:toast", listen);
    }
  });

  it("plans from the checkbox, which takes no letters of its own", () => {
    const onPlan = vi.fn();
    renderRow({ onPlan }, { ...task, title: "Write" });
    const box = screen.getByRole("checkbox", { name: "Write" });
    box.focus();
    fireEvent.keyDown(box, { key: "p" });
    expect(onPlan).toHaveBeenCalledTimes(1);
  });

  it("ignores p raised inside the portalled actions menu", () => {
    const onPlan = vi.fn();
    renderRow({ onPlan });
    const item = within(openMenuPanel()).getByRole("menuitem", { name: "Rename" });
    fireEvent.keyDown(item, { key: "p" });
    expect(onPlan).not.toHaveBeenCalled();
  });

  it("ignores p while the title is being edited", () => {
    const onPlan = vi.fn();
    renderRow({ onPlan }, { ...task, title: "Write" });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "p" });
    expect(onPlan).not.toHaveBeenCalled();
  });
});

describe("TaskRow blocks", () => {
  it("shows the block time, offers Block now and Take off the timeline, and answers n", () => {
    const onBlockNow = vi.fn();
    const onUnblock = vi.fn();
    const focus: unknown[] = [];
    const listen = (e: Event) => focus.push((e as CustomEvent).detail);
    window.addEventListener("sb:timeline-focus", listen);
    try {
      renderRow({ onBlockNow, onUnblock, blockDate: "2026-09-16" }, { ...task, blocks: [{ id: 1, taskId: task.id, startsAt: "2026-09-16T10:30:00", minutes: 25, spentMinutes: 0 }] });
      fireEvent.click(screen.getByRole("button", { name: "Blocked at 10:30" }));
      // The chip names the session it speaks for, not only the task that holds it.
      expect(focus).toEqual([{ taskId: task.id, blockId: 1 }]);
      fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Take off the timeline" }));
      expect(onUnblock).toHaveBeenCalled();
      const title = screen.getByRole("button", { name: task.title });
      title.focus();
      fireEvent.keyDown(title, { key: "n" });
      expect(onBlockNow).toHaveBeenCalled();
    } finally {
      window.removeEventListener("sb:timeline-focus", listen);
    }
  });

  it("only tells the time for a block the row's own day does not hold", () => {
    // No day to measure against, and a day that is not the block's: neither has a column here
    // to jump to, so the figure is said rather than offered.
    for (const extra of [{ onBlockNow: vi.fn() }, { onBlockNow: vi.fn(), blockDate: "2026-09-17" }]) {
      renderRow(extra, { ...task, blocks: [{ id: 1, taskId: task.id, startsAt: "2026-09-16T10:30:00", minutes: 25, spentMinutes: 0 }] });
      expect(screen.queryByRole("button", { name: /^Blocked at/ })).toBeNull();
      expect(screen.getByTitle("Blocked on Wed 16 at 10:30").textContent).toBe("10:30");
      cleanup();
    }
  });

  it("names the session still to come when the row's own day holds none", () => {
    renderRow(
      {},
      {
        ...task,
        blocks: [
          { id: 1, taskId: task.id, startsAt: "2026-09-15T09:00:00", minutes: 25, spentMinutes: 0 },
          { id: 2, taskId: task.id, startsAt: "2026-09-18T14:00:00", minutes: 25, spentMinutes: 0 },
        ],
      },
    );
    // Yesterday's session is history; the one still coming is what the chip says.
    expect(screen.getByTitle("Blocked on Fri 18 at 14:00").textContent).toBe("14:00");
    expect(screen.queryByTitle(/Blocked on Tue 15/)).toBeNull();
  });

  it("falls back to the latest session once they are all behind", () => {
    renderRow(
      {},
      {
        ...task,
        blocks: [
          { id: 1, taskId: task.id, startsAt: "2026-09-10T09:00:00", minutes: 25, spentMinutes: 0 },
          { id: 2, taskId: task.id, startsAt: "2026-09-14T14:00:00", minutes: 25, spentMinutes: 0 },
        ],
      },
    );
    expect(screen.getByTitle("Blocked on Mon 14 at 14:00").textContent).toBe("14:00");
  });

  it("leaves n alone on a row that is already finished", () => {
    const onBlockNow = vi.fn();
    renderRow({ onBlockNow }, { ...task, title: "Write", status: "done" });
    const title = screen.getByRole("button", { name: "Write" });
    title.focus();
    fireEvent.keyDown(title, { key: "n" });
    expect(onBlockNow).not.toHaveBeenCalled();
  });

  it("keeps the chip and the unblock item away from a task with no block", () => {
    renderRow({ onBlockNow: vi.fn(), onUnblock: vi.fn() });
    expect(screen.queryByRole("button", { name: /^Blocked at/ })).toBeNull();
    const items = within(openMenuPanel()).getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toContain("Block now");
    expect(items).not.toContain("Take off the timeline");
  });

  it("leaves n alone where the row cannot block anything", () => {
    const onPlan = vi.fn();
    renderRow({ onPlan }, { ...task, title: "Write" });
    const title = screen.getByRole("button", { name: "Write" });
    fireEvent.keyDown(title, { key: "n" });
    expect(onPlan).not.toHaveBeenCalled();
  });

  it("counts the day's other sessions on the chip and speaks for the first", () => {
    const focus: unknown[] = [];
    const listen = (e: Event) => focus.push((e as CustomEvent).detail);
    window.addEventListener("sb:timeline-focus", listen);
    try {
      renderRow(
        { blockDate: "2026-09-16" },
        {
          ...task,
          blocks: [
            { id: 4, taskId: task.id, startsAt: "2026-09-16T10:30:00", minutes: 45, spentMinutes: 0 },
            { id: 5, taskId: task.id, startsAt: "2026-09-16T14:00:00", minutes: 45, spentMinutes: 0 },
          ],
        },
      );
      const chip = screen.getByRole("button", { name: "Blocked at 10:30, 2 sessions" });
      expect(chip.textContent).toBe("10:30+1");
      fireEvent.click(chip);
      expect(focus).toEqual([{ taskId: task.id, blockId: 4 }]);
    } finally {
      window.removeEventListener("sb:timeline-focus", listen);
    }
  });

  it("counts only the sessions the row's own day holds", () => {
    renderRow(
      { blockDate: "2026-09-16" },
      {
        ...task,
        blocks: [
          { id: 4, taskId: task.id, startsAt: "2026-09-16T10:30:00", minutes: 45, spentMinutes: 0 },
          { id: 5, taskId: task.id, startsAt: "2026-09-17T09:00:00", minutes: 45, spentMinutes: 0 },
        ],
      },
    );
    expect(screen.getByRole("button", { name: "Blocked at 10:30" }).textContent).toBe("10:30");
  });

  it("keeps the n it handled from reaching the window", () => {
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", onKey);
    try {
      renderRow({ onBlockNow: vi.fn() }, { ...task, title: "Write" });
      fireEvent.keyDown(screen.getByRole("button", { name: "Write" }), { key: "n" });
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
  });
});

describe("TaskRow placing and splitting", () => {
  const twoHours: TaskDTO = { ...task, estimateMinutes: 120 };

  it("places from the menu and from f, and leaves f alone where it is not offered", () => {
    const onPlace = vi.fn();
    renderRow({ onPlace }, twoHours);
    fireEvent.click(within(openMenuPanel()).getByRole("menuitem", { name: "Place in free slots" }));
    expect(onPlace).toHaveBeenCalledTimes(1);

    const title = screen.getByRole("button", { name: task.title });
    title.focus();
    fireEvent.keyDown(title, { key: "f" });
    expect(onPlace).toHaveBeenCalledTimes(2);

    // No handler, no letter: a row outside the plan pane keeps f for whatever else wants it.
    cleanup();
    const onPlan = vi.fn();
    renderRow({ onPlan }, twoHours);
    expect(within(openMenuPanel()).queryByRole("menuitem", { name: "Place in free slots" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: task.title }), { key: "f" });
    expect(onPlan).not.toHaveBeenCalled();
  });

  it("refuses f on a row that is already finished", () => {
    const onPlace = vi.fn();
    renderRow({ onPlace }, { ...twoHours, status: "done" });
    fireEvent.keyDown(screen.getByRole("button", { name: task.title }), { key: "f" });
    expect(onPlace).not.toHaveBeenCalled();
  });

  it("keeps the f it handled from reaching the window", () => {
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", onKey);
    try {
      renderRow({ onPlace: vi.fn() }, twoHours);
      fireEvent.keyDown(screen.getByRole("button", { name: task.title }), { key: "f" });
      expect(seen).toEqual([]);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
  });

  it("offers the session lengths, marks the one in force and saves a choice", () => {
    const onSplit = vi.fn();
    renderRow({ onSplit }, { ...twoHours, sessionMinutes: 45 });
    const trigger = within(openMenuPanel()).getByRole("menuitem", { name: "Split into" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);
    const lengths = screen.getByRole("menu", { name: "Split into" });
    expect(Array.from(lengths.querySelectorAll('[role="menuitemradio"]')).map((el) => el.textContent)).toEqual([
      "25m", "45m", "1h", "1h 30m", "One session",
    ]);
    expect(screen.getByRole("menuitemradio", { name: "45m" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "45m" }));
    expect(onSplit).toHaveBeenCalledWith(45);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("puts the whole estimate in one session, and says so while it is unset", () => {
    const onSplit = vi.fn();
    renderRow({ onSplit }, twoHours);
    fireEvent.click(within(openMenuPanel()).getByRole("menuitem", { name: "Split into" }));
    expect(screen.getByRole("menuitemradio", { name: "One session" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "One session" }));
    expect(onSplit).toHaveBeenCalledWith(null);
  });

  it("closes the other submenu when one is opened", () => {
    renderRow({ onPlanDate: vi.fn(), onSplit: vi.fn() }, twoHours);
    const panel = openMenuPanel();
    fireEvent.click(within(panel).getByRole("menuitem", { name: "Plan for" }));
    expect(screen.getByRole("menu", { name: "Plan for" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("menuitem", { name: "Split into" }));
    expect(screen.getByRole("menu", { name: "Split into" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Plan for" })).toBeNull();
    fireEvent.click(within(panel).getByRole("menuitem", { name: "Plan for" }));
    expect(screen.queryByRole("menu", { name: "Split into" })).toBeNull();
  });

  it("escape backs out of the lengths before it closes the menu", () => {
    renderRow({ onSplit: vi.fn() }, twoHours);
    const trigger = within(openMenuPanel()).getByRole("menuitem", { name: "Split into" });
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Split into" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

/**
 * The menu is where most people plan a task, and it used to be the one path that said nothing:
 * the toast hung off the keyboard handler alone. On a surface that does not show the plan, a
 * silent write is indistinguishable from a button that does not work.
 */
describe("TaskRow planning from the menu", () => {
  function toastsFrom(run: () => void): unknown[] {
    const toasts: unknown[] = [];
    const listen = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener("sb:toast", listen);
    try {
      run();
    } finally {
      window.removeEventListener("sb:toast", listen);
    }
    return toasts;
  }

  it("says so when planning through the menu", () => {
    const onPlan = vi.fn();
    const toasts = toastsFrom(() => {
      renderRow({ onPlan }, { ...task, title: "Write" });
      fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Plan for today" }));
    });
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([{ text: "Planned for today" }]);
  });

  it("says so when taking it off through the menu", () => {
    const onPlan = vi.fn();
    const toasts = toastsFrom(() => {
      renderRow({ onPlan, planned: true }, { ...task, title: "Write" });
      fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from plan" }));
    });
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([{ text: "Taken off the plan" }]);
  });

  it("names the day when one is picked from the submenu", () => {
    const onPlanDate = vi.fn();
    const toasts = toastsFrom(() => {
      renderRow({ onPlanDate, planFrom: "2026-09-25" }, { ...task, title: "Write" });
      fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Plan for/ }));
      const submenu = screen.getByRole("menu", { name: "Plan for" });
      fireEvent.click(within(submenu).getAllByRole("menuitem")[0]);
    });
    expect(onPlanDate).toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
  });
});
