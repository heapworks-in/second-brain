// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { PlanTaskDTO } from "@/lib/dto";
import { FocusPane } from "./focus-pane";
import { resetFocusStore } from "../focus/focus-store";

const task: PlanTaskDTO = {
  id: 4,
  planId: 41,
  title: "Write the migration",
  notes: "",
  status: "open",
  priority: "normal",
  dueDate: null,
  containerId: null,
  sourceItemId: null,
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
};

const SETTINGS = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4 };

/** The one request the pane's store makes on mount, answered the way the server would. */
function stubFocus(payload: Record<string, unknown>) {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/focus" && (init?.method ?? "GET") === "GET") {
        return Response.json({ run: null, settings: SETTINGS, completedToday: 0, break: { endsAt: null, remainingMs: 0, minutes: 0 }, ...payload });
      }
      if (url.startsWith("/api/tasks")) {
        return Response.json([
          { ...task, id: 77, title: "Review the rollout" },
          { ...task, id: 78, title: "Answer the auditors" },
        ]);
      }
      return Response.json({});
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.unstubAllGlobals();
});

describe("FocusPane", () => {
  beforeEach(() => resetFocusStore());

  it("offers the next planned task, at the configured length", async () => {
    stubFocus({});
    render(<FocusPane nextTask={task} />);
    expect(await screen.findByRole("button", { name: "25m on Write the migration" })).toBeTruthy();
  });

  /** An unplanned day used to be a dead end here: the pane said "plan something" and offered no
   *  way to start at all, which is the one time somebody most wants to just start. */
  it("can still start on an unplanned day", async () => {
    stubFocus({});
    render(<FocusPane nextTask={null} />);
    expect(await screen.findByRole("button", { name: "25m on…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Just 25m" })).toBeTruthy();
  });

  it("starts a run on nothing in particular, naming no task", async () => {
    const calls = stubFocus({});
    render(<FocusPane nextTask={task} />);
    fireEvent.click(await screen.findByRole("button", { name: "Just 25m" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/focus" && c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/focus")!.body).toEqual({ minutes: 25 });
  });

  it("offers any open task, not only the planned one", async () => {
    const calls = stubFocus({});
    render(<FocusPane nextTask={task} />);
    fireEvent.click(await screen.findByRole("button", { name: "On…" }));
    const other = await screen.findByRole("button", { name: "Review the rollout" });
    fireEvent.click(other);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/focus" && c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/focus")!.body).toEqual({ taskId: 77, minutes: 25 });
  });

  it("filters the tasks it offers", async () => {
    stubFocus({});
    render(<FocusPane nextTask={task} />);
    fireEvent.click(await screen.findByRole("button", { name: "On…" }));
    await screen.findByRole("button", { name: "Review the rollout" });
    fireEvent.change(screen.getByLabelText("Find a task to focus on"), { target: { value: "rollout" } });
    expect(screen.getByRole("button", { name: "Review the rollout" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Answer the auditors" })).toBeNull();
  });

  /** The cycle has been configured since the feature shipped and was never once shown. */
  it("shows how far through the cycle the day is", async () => {
    stubFocus({ completedToday: 3 });
    render(<FocusPane nextTask={task} />);
    expect(await screen.findByRole("img", { name: "3 of 4 before a long break" })).toBeTruthy();
  });

  it("reads a completed cycle as a full row, not an empty one", async () => {
    stubFocus({ completedToday: 4 });
    render(<FocusPane nextTask={task} />);
    expect(await screen.findByRole("img", { name: "4 of 4 before a long break" })).toBeTruthy();
  });

  it("counts down the run it is given, and offers to stop it", async () => {
    stubFocus({
      run: { id: 1, taskId: 4, taskTitle: "Write the migration", startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt: null, plannedMinutes: 25, actualMinutes: null, outcome: null, blockId: null },
    });
    render(<FocusPane nextTask={task} />);
    expect(await screen.findByText("Focusing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByText(/^2[34]:/)).toBeTruthy();
  });

  // The break is the part that used to vanish on navigation: a pane that never saw it start must
  // still show it, which is only possible because it comes from the server.
  it("shows a break it never started itself", async () => {
    stubFocus({ break: { endsAt: new Date(Date.now() + 240_000).toISOString(), remainingMs: 240_000, minutes: 5 } });
    render(<FocusPane nextTask={task} />);
    expect(await screen.findByText("Short break")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to work" })).toBeTruthy();
  });

  it("names the long break as the long one", async () => {
    stubFocus({ break: { endsAt: new Date(Date.now() + 600_000).toISOString(), remainingMs: 600_000, minutes: 15 } });
    render(<FocusPane nextTask={task} />);
    expect(await screen.findByText("Long break")).toBeTruthy();
  });

  it("asks the server for a break rather than deciding the length itself", async () => {
    const calls = stubFocus({});
    render(<FocusPane nextTask={task} />);
    fireEvent.click(await screen.findByRole("button", { name: "Break" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/focus/break" && c.method === "POST")).toBe(true));
    // No minutes: which break this is depends on the cycle, which the server already counts.
    expect(calls.find((c) => c.url === "/api/focus/break")!.body).toEqual({});
  });

  it("ends the break through the server, so another surface sees it end too", async () => {
    const calls = stubFocus({ break: { endsAt: new Date(Date.now() + 60_000).toISOString(), remainingMs: 60_000, minutes: 5 } });
    render(<FocusPane nextTask={task} />);
    fireEvent.click(await screen.findByRole("button", { name: "Back to work" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/focus/break" && c.method === "DELETE")).toBe(true));
  });

  describe("the timebox", () => {
    const TIMEBOX = { ...SETTINGS, mode: "timebox" as const };

    it("offers the lengths a box comes in, and starts the one chosen rather than the saved default", async () => {
      const calls = stubFocus({ settings: TIMEBOX });
      render(<FocusPane nextTask={task} />);
      // The saved default is where it starts, so both rhythms open on the same number.
      expect(await screen.findByRole("radio", { name: "25m", checked: true })).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "45m" }));
      fireEvent.click(await screen.findByRole("button", { name: "45m on Write the migration" }));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/focus" && c.method === "POST")).toBe(true));
      expect(calls.find((c) => c.method === "POST" && c.url === "/api/focus")!.body).toEqual({ taskId: 4, minutes: 45 });
    });

    it("offers no break and no cycle: a box ends in a decision, not a rhythm", async () => {
      stubFocus({ settings: TIMEBOX, completedToday: 3 });
      render(<FocusPane nextTask={task} />);
      await screen.findByRole("button", { name: /on Write the migration/ });
      expect(screen.queryByRole("button", { name: "Break" })).toBeNull();
      expect(screen.queryByRole("img", { name: /before a long break/ })).toBeNull();
    });

    it("keeps the box length still while one is running", async () => {
      stubFocus({
        settings: TIMEBOX,
        run: {
          id: 1,
          taskId: 4,
          taskTitle: "Write the migration",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          endedAt: null,
          plannedMinutes: 45,
          actualMinutes: null,
          outcome: null,
          blockId: null,
        },
      });
      render(<FocusPane nextTask={task} />);
      await screen.findByText("Focusing");
      expect(screen.queryByRole("radio")).toBeNull();
    });

    it("saves the rhythm rather than holding it in the pane, so it is still chosen tomorrow", async () => {
      const calls = stubFocus({});
      render(<FocusPane nextTask={task} />);
      fireEvent.click(await screen.findByRole("button", { name: "timebox" }));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/focus" && c.method === "PATCH")).toBe(true));
      expect(calls.find((c) => c.url === "/api/settings/focus")!.body).toEqual({ mode: "timebox" });
      // Shown straight away rather than after the round trip.
      expect(await screen.findByRole("radio", { name: "25m" })).toBeTruthy();
    });
  });
});
