// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import type { PlannerDayDTO, PlanTaskDTO, TaskDTO } from "@/lib/dto";
import { DayView } from "./day-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/planner" }));

const TODAY = "2026-09-23";

const loose: TaskDTO = {
  id: 1, title: "Loose one", notes: "", status: "open", priority: "normal", dueDate: null, containerId: null, sourceItemId: null, requester: null, askedOn: null,
  estimateMinutes: null, sessionMinutes: null, blocks: [], goals: [], spentMinutes: 0, likeThisMinutes: null, completedAt: null, sortOrder: 0, createdAt: "", updatedAt: "",
};

/** A planned task holding one session on the day, so the column has a block to write about. */
const planned: PlanTaskDTO = {
  ...loose,
  id: 2,
  title: "Write the brief",
  planId: 3,
  estimateMinutes: 45,
  blocks: [{ id: 5, taskId: 2, startsAt: `${TODAY}T10:30:00`, minutes: 45, spentMinutes: 0 }],
};

function day(): PlannerDayDTO {
  return {
    date: TODAY,
    plan: [],
    unfinishedYesterday: [],
    meetings: [],
    calendar: { calendarsSeen: 1, permission: true },
    sources: { owed: [], inbox: [loose], due: { overdue: [], today: [] }, projects: [], areas: [] },
    capacity: { freeMinutes: 540, plannedMinutes: 0, unestimated: 0, workHours: "09:00-18:00", workingDays: [1, 2, 3, 4, 5], blockedMinutes: 0, unplacedMinutes: 0, drift: null, forecastMinutes: null, leftTodayMinutes: 540 },
  };
}

function mount() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/meetings/recorder" ? Response.json({ state: "idle", missing: [] }) : Response.json({}))),
  );
  render(<DayView day={day()} today={TODAY} onRefresh={vi.fn()} />);
}

/** Every request the day made, with the session routes answering the way they do. */
function mountPlan(): { calls: { url: string; method?: string; body: unknown }[]; onRefresh: ReturnType<typeof vi.fn> } {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/meetings/recorder") return Response.json({ state: "idle", missing: [] });
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
      // The add answers with the session it made; everything else answers with nothing.
      return init?.method === "POST" && url === "/api/blocks" ? Response.json({ id: 9, taskId: 2, startsAt: `${TODAY}T10:35:00`, minutes: 25, spentMinutes: 0 }, { status: 201 }) : new Response(null, { status: 204 });
    }),
  );
  const onRefresh = vi.fn();
  render(<DayView day={{ ...day(), plan: [planned] }} today={TODAY} onRefresh={onRefresh} />);
  return { calls, onRefresh };
}

// jsdom has neither DragEvent nor PointerEvent; a MouseEvent in their place carries clientY,
// which is all the column measures a drop by.
beforeAll(() => {
  const w = window as unknown as Record<string, unknown>;
  if (!w.DragEvent) w.DragEvent = window.MouseEvent;
  if (!w.PointerEvent) w.PointerEvent = window.MouseEvent;
});

function pickerKey(): void {
  act(() => {
    fireEvent.keyDown(window, { key: "/", metaKey: true });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    /* jsdom without storage */
  }
});

describe("DayView", () => {
  it("writes the plan first, then the timeline, with the picker inside the plan", () => {
    mount();
    const plan = screen.getByRole("list", { name: "Plan" });
    const timeline = screen.getByRole("region", { name: "Timeline" });
    // Tab order is document order: the day's own work comes before the calendar beside it.
    expect(plan.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Add a task for today" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves and takes away a session through the block routes, and reloads the day", async () => {
    const { calls, onRefresh } = mountPlan();
    const block = screen.getByRole("group", { name: "Write the brief, 10:30 to 11:15" });
    block.focus();
    fireEvent.keyDown(block, { key: "ArrowDown" });
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: "/api/blocks/5", method: "PATCH", body: { startsAt: `${TODAY}T10:45:00` } }));
    fireEvent.keyDown(block, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: "/api/blocks/5", method: "PATCH", body: { minutes: 50 } }));
    fireEvent.keyDown(block, { key: "Backspace" });
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: "/api/blocks/5", method: "DELETE", body: null }));
    // Every one of them says so, and the plan beside the column reads the day back.
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(3));
  });

  it("places a dropped plan row as a new session", async () => {
    const { calls } = mountPlan();
    const col = screen.getByTestId("timeline-column");
    Object.defineProperty(col, "getBoundingClientRect", { value: () => ({ top: 100, left: 0, width: 400, height: 540 }) });
    const dt = { types: ["application/x-sb-plan", "application/x-sb-plan-minutes-45"], getData: () => String(planned.id), dropEffect: "move" };
    fireEvent.drop(col, { dataTransfer: dt, clientY: 100 + 93 });
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({ url: "/api/blocks", method: "POST", body: { taskId: planned.id, startsAt: `${TODAY}T10:35:00`, minutes: 45 } }),
    );
  });

  it("puts the keyboard in the picker with its own key", () => {
    mount();
    pickerKey();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Add a task for today" }));
    expect(screen.getByRole("listbox", { name: "Tasks to plan" })).toBeTruthy();
  });
});
