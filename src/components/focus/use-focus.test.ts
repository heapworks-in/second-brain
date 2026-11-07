// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup, act, waitFor } from "@testing-library/react";
import { useFocus } from "./use-focus";
import { resetFocusStore } from "./focus-store";
import type { FocusRunDTO, FocusSettingsDTO } from "@/lib/dto";

const STARTED_AT = "2026-09-25T10:00:00.000Z";

const SETTINGS: FocusSettingsDTO = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" };

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

beforeEach(() => {
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  // Spies on `window.setInterval`/`addEventListener` (see the "polls, ticks and listens" test)
  // are restored before switching the timer system back: `vi.spyOn` remembers whatever
  // implementation was live when it was installed, which under fake timers is the fake one —
  // restoring the timer system first and the spies after would leave `window.setInterval`
  // pinned to that fake implementation for every later test in this file.
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useFocus", () => {
  it("counts remainingMs down from startedAt + plannedMinutes without asking the server again", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/focus" && !init?.method) return Response.json({ run: run({ plannedMinutes: 25 }), settings: SETTINGS, completedToday: 0 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(STARTED_AT));

    const { result } = renderHook(() => useFocus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.run?.id).toBe(1);
    expect(result.current.remainingMs).toBe(25 * 60_000);

    const getCalls = () => fetchMock.mock.calls.filter(([u, i]) => String(u) === "/api/focus" && !(i as RequestInit | undefined)?.method).length;
    expect(getCalls()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    // Fake timers make the tick's landing deterministic: the interval was armed during the 1ms
    // flush above, so its ticks land at 1000ms, 2000ms, ... — 12,000ms elapsed by here, exactly.
    expect(result.current.remainingMs).toBe(25 * 60_000 - 12_000);
    // The tick recomputes the countdown locally; it never asks the server again to do it.
    expect(getCalls()).toBe(1);
  });

  it("finishes the run exactly once when the countdown reaches zero, not once per tick", async () => {
    let live: FocusRunDTO | null = run({ plannedMinutes: 1 });
    let patchCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/focus" && !init?.method) return Response.json({ run: live, settings: SETTINGS, completedToday: 0 });
      if (url === "/api/focus/1" && init?.method === "PATCH") {
        patchCalls += 1;
        expect(JSON.parse(String(init.body))).toEqual({ outcome: "completed" });
        const finished: FocusRunDTO = { ...live!, endedAt: new Date().toISOString(), actualMinutes: 1, outcome: "completed" };
        live = null;
        return Response.json({ run: finished, where: [] });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(STARTED_AT));

    renderHook(() => useFocus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    // Well past the one-minute plan, one second at a time: the tick fires many times over.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });

    expect(patchCalls).toBe(1);
  });

  it("finishes the run exactly once across many mounted consumers, not once per consumer", async () => {
    // The bug this guards against only shows up with more than one hook instance in the tree:
    // a per-instance guard (a ref inside the old, since-removed per-hook implementation) lets
    // every instance race to PATCH the same run. This is the failing case that shipped against
    // a single-`renderHook` version of the test above — the shared store fixes it by construction,
    // since there is exactly one guard no matter how many components subscribe.
    let live: FocusRunDTO | null = run({ plannedMinutes: 1 });
    let patchCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/focus" && !init?.method) return Response.json({ run: live, settings: SETTINGS, completedToday: 0 });
      if (url === "/api/focus/1" && init?.method === "PATCH") {
        patchCalls += 1;
        const finished: FocusRunDTO = { ...live!, endedAt: new Date().toISOString(), actualMinutes: 1, outcome: "completed" };
        live = null;
        return Response.json({ run: finished, where: [] });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(STARTED_AT));

    // Ten independent hook instances, the shape a planner day full of `FocusButton`s produces.
    const hooks = Array.from({ length: 10 }, () => renderHook(() => useFocus()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    for (const h of hooks) expect(h.result.current.run?.id).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });

    expect(patchCalls).toBe(1);
    for (const h of hooks) expect(h.result.current.run).toBeNull();
    hooks.forEach((h) => h.unmount());
  });

  it("polls, ticks and listens exactly once no matter how many consumers are mounted", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/focus" && !init?.method) return Response.json({ run: run({ plannedMinutes: 25 }), settings: SETTINGS, completedToday: 0 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(STARTED_AT));
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const addListenerSpy = vi.spyOn(window, "addEventListener");

    const hooks = Array.from({ length: 20 }, () => renderHook(() => useFocus()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    // One GET regardless of how many consumers subscribed.
    expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === "/api/focus" && !(i as RequestInit | undefined)?.method)).toHaveLength(1);
    // One tick interval and one poll interval, not twenty of each.
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    // One `sb:focus-changed` listener, not twenty.
    expect(addListenerSpy.mock.calls.filter(([type]) => type === "sb:focus-changed")).toHaveLength(1);

    hooks.forEach((h) => h.unmount());
  });

  it("a failed start leaves run null and sets error", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/focus" && !init?.method) return Response.json({ run: null, settings: SETTINGS, completedToday: 0 });
      if (url === "/api/focus" && init?.method === "POST") return Response.json({ error: "Task not found" }, { status: 404 });
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFocus());
    await waitFor(() => expect(result.current.run).toBeNull());

    act(() => {
      result.current.start({ taskId: 999 });
    });

    await waitFor(() => expect(result.current.error).toBe("Task not found"));
    expect(result.current.run).toBeNull();
  });

  it("N1: a load already in flight when the last subscriber unmounts cannot arm a timer afterward", async () => {
    let resolveGet!: (res: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/focus" && !init?.method) return new Promise<Response>((resolve) => (resolveGet = resolve));
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(STARTED_AT));

    const { unmount } = renderHook(() => useFocus());
    // The GET fired on mount, still in flight. Unmounting drops the subscriber count to zero and
    // stops the engine before that request ever resolves.
    unmount();

    // Resolves after the last subscriber is gone, with a run already past its planned end — the
    // shape that, without the fix, ticks once and PATCHes with nothing mounted at all.
    resolveGet(Response.json({ run: run({ startedAt: "2020-01-01T00:00:00.000Z", plannedMinutes: 1 }), settings: SETTINGS, completedToday: 0 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    const patches = fetchMock.mock.calls.filter(([u, i]) => String(u).startsWith("/api/focus/") && (i as RequestInit | undefined)?.method === "PATCH");
    expect(patches).toHaveLength(0);
  });

  it("N2: a manual stop landing while the auto-finish PATCH is in flight sends only one PATCH", async () => {
    let live: FocusRunDTO | null = run({ plannedMinutes: 1 });
    const outcomes: string[] = [];
    let resolvePatch!: (res: Response) => void;
    let patchCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/focus" && !init?.method) return Response.json({ run: live, settings: SETTINGS, completedToday: 0 });
      if (url === "/api/focus/1" && init?.method === "PATCH") {
        patchCalls += 1;
        outcomes.push((JSON.parse(String(init.body)) as { outcome: string }).outcome);
        // The auto-finish PATCH is held open, so a manual stop has a window to race it.
        return new Promise<Response>((resolve) => (resolvePatch = resolve));
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(STARTED_AT));

    const { result } = renderHook(() => useFocus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // Past the one-minute plan: the tick's auto-finish fires and its PATCH is now in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(patchCalls).toBe(1);

    // A manual Stop lands while that PATCH is still outstanding — `⌘⇧F`'s exact path, which
    // carries no `disabled={busy}` of its own.
    act(() => {
      void result.current.finish("stopped");
    });

    live = { ...live!, endedAt: new Date().toISOString(), actualMinutes: 1, outcome: "completed" };
    resolvePatch(Response.json({ run: live, where: [] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(patchCalls).toBe(1);
    expect(outcomes).toEqual(["completed"]);
  });

  it("F9: a failed auto-finish PATCH is not refired from the next tick, once a second", async () => {
    const live: FocusRunDTO = run({ plannedMinutes: 1 });
    let patchCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/focus" && !init?.method) return Response.json({ run: live, settings: SETTINGS, completedToday: 0 });
      if (url === "/api/focus/1" && init?.method === "PATCH") {
        patchCalls += 1;
        return Response.json({ error: "offline" }, { status: 500 });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(STARTED_AT));

    renderHook(() => useFocus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    // Well past the one-minute plan, one second at a time — every tick after the first failure
    // would fire another PATCH without the guard.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });

    expect(patchCalls).toBe(1);
  });
});
