// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Shortcuts } from "./shortcuts";
import { resetFocusStore } from "./focus/focus-store";
import type { FocusRunDTO, FocusSettingsDTO } from "@/lib/dto";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const SETTINGS: FocusSettingsDTO = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" };
const STARTED_AT = "2026-09-25T10:00:00.000Z";

function run(over: Partial<FocusRunDTO> = {}): FocusRunDTO {
  return {
    id: 1,
    taskId: 9,
    taskTitle: "Draft the brief",
    blockId: null,
    startedAt: STARTED_AT,
    endedAt: null,
    plannedMinutes: 25,
    actualMinutes: null,
    outcome: null,
    ...over,
  };
}

/** Answers the focus poll with `live`, and records every call `Shortcuts` makes. `writes`
 * excludes the plain GET, so a test can assert exactly what a keypress caused. */
function stubFocus(live: FocusRunDTO | null) {
  const calls: { url: string; method?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method });
      if (url === "/api/focus" && !init?.method) return Response.json({ run: live, settings: SETTINGS, completedToday: 0 });
      if (url === "/api/focus" && init?.method === "POST") return Response.json(run({ id: 2, taskId: JSON.parse(String(init.body)).taskId }), { status: 201 });
      if (url.startsWith("/api/focus/") && init?.method === "PATCH") return Response.json({ run: { ...(live ?? run()), outcome: "stopped" }, where: [] });
      return new Response("{}", { status: 404 });
    }),
  );
  return {
    calls,
    /** Every call after the initial poll: what a keypress actually did. */
    writes: () => calls.filter((c) => c.method),
    loaded: () => calls.some((c) => c.url === "/api/focus" && !c.method),
  };
}

beforeEach(() => {
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  push.mockClear();
});

describe("Shortcuts", () => {
  it("calls the prompt bar on a bare c", () => {
    stubFocus(null);
    const focus = vi.fn();
    window.addEventListener("sb:prompt-focus", focus);
    render(<Shortcuts />);
    fireEvent.keyDown(window, { key: "c" });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    window.removeEventListener("sb:prompt-focus", focus);
  });

  it("leaves the c in g c to the capture route, and stays out of a field", () => {
    stubFocus(null);
    const focus = vi.fn();
    window.addEventListener("sb:prompt-focus", focus);
    render(<Shortcuts />);
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "c" });
    expect(push).toHaveBeenCalledWith("/capture");
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "c" });
    input.remove();
    expect(focus).not.toHaveBeenCalled();
    window.removeEventListener("sb:prompt-focus", focus);
  });

  it("navigates to Help on a bare ?", () => {
    stubFocus(null);
    render(<Shortcuts />);
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(push).toHaveBeenCalledWith("/help");
  });

  it("stays out of a field on ?, even though it's a shifted key", () => {
    stubFocus(null);
    render(<Shortcuts />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "?", shiftKey: true });
    input.remove();
    expect(push).not.toHaveBeenCalled();
  });

  it("navigates to Help on g u", () => {
    stubFocus(null);
    render(<Shortcuts />);
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "u" });
    expect(push).toHaveBeenCalledWith("/help");
  });

  describe("⌘⇧F", () => {
    function row(taskId: number): HTMLLIElement {
      const li = document.createElement("li");
      li.dataset.taskId = String(taskId);
      const button = document.createElement("button");
      li.appendChild(button);
      document.body.appendChild(li);
      return li;
    }

    it("starts a run on the focused row's task when none is live", async () => {
      const focus = stubFocus(null);
      render(<Shortcuts />);
      const li = row(9);
      await waitFor(() => expect(focus.loaded()).toBe(true));

      fireEvent.keyDown(li.querySelector("button")!, { key: "f", metaKey: true, shiftKey: true });

      await waitFor(() => expect(focus.writes()).toEqual([{ url: "/api/focus", method: "POST" }]));
      li.remove();
    });

    it("does nothing when nothing is focused and no run is live", async () => {
      const focus = stubFocus(null);
      render(<Shortcuts />);
      await waitFor(() => expect(focus.loaded()).toBe(true));

      fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });

      // Give a would-be write a chance to land before asserting its absence.
      await new Promise((r) => setTimeout(r, 10));
      expect(focus.writes()).toEqual([]);
    });

    it("does not fire from inside a text input, even one sitting inside a task row", async () => {
      const focus = stubFocus(null);
      render(<Shortcuts />);
      const li = row(9);
      const input = document.createElement("input");
      li.appendChild(input);
      await waitFor(() => expect(focus.loaded()).toBe(true));

      fireEvent.keyDown(input, { key: "f", metaKey: true, shiftKey: true });

      await new Promise((r) => setTimeout(r, 10));
      expect(focus.writes()).toEqual([]);
      li.remove();
    });

    it("stops the live run when the focused row is the one running", async () => {
      const focus = stubFocus(run({ taskId: 9 }));
      render(<Shortcuts />);
      const li = row(9);
      await waitFor(() => expect(focus.loaded()).toBe(true));

      fireEvent.keyDown(li.querySelector("button")!, { key: "f", metaKey: true, shiftKey: true });

      await waitFor(() => expect(focus.writes()).toEqual([{ url: "/api/focus/1", method: "PATCH" }]));
      li.remove();
    });

    it("stops the live run when nothing is focused", async () => {
      const focus = stubFocus(run({ taskId: 9 }));
      render(<Shortcuts />);
      await waitFor(() => expect(focus.loaded()).toBe(true));

      fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });

      await waitFor(() => expect(focus.writes()).toEqual([{ url: "/api/focus/1", method: "PATCH" }]));
    });

    it("stops the running task and starts the newly focused one, in the same press", async () => {
      const focus = stubFocus(run({ taskId: 9 }));
      render(<Shortcuts />);
      const li = row(40);
      await waitFor(() => expect(focus.loaded()).toBe(true));

      fireEvent.keyDown(li.querySelector("button")!, { key: "f", metaKey: true, shiftKey: true });

      await waitFor(() =>
        expect(focus.writes()).toEqual([
          { url: "/api/focus/1", method: "PATCH" },
          { url: "/api/focus", method: "POST" },
        ]),
      );
      li.remove();
    });
  });
});
