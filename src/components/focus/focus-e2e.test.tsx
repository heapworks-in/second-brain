// @vitest-environment jsdom
// End-to-end coverage for the F3 path: the store completes a run on its own, dispatches
// `sb:focus-completed` itself, and `BreakOffer` reads the break length that event carries.
// `break-offer.test.tsx` dispatches that event by hand, which proves the component but not the
// store's supply of `completedToday`/`settings` — exactly what F3 got wrong (round 0 read them
// from inside a `setState` updater and always produced `{completedToday: 1, settings:
// DEFAULT_SETTINGS}`). This test never touches the event directly.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { FocusChip } from "./focus-chip";
import { BreakOffer } from "./break-offer";
import { resetFocusStore } from "./focus-store";
import type { FocusRunDTO, FocusSettingsDTO } from "@/lib/dto";

const STARTED_AT = "2026-09-25T10:00:00.000Z";
// Deliberately not the module's own DEFAULT_SETTINGS shape: a regression that falls back to it
// (or to `completedToday: 1`) fails this test, the same way it failed F3.
const SETTINGS: FocusSettingsDTO = { defaultMinutes: 25, shortBreak: 7, longBreak: 21, longBreakEvery: 4, mode: "pomodoro" };

beforeEach(() => {
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("focus completion, end to end", () => {
  it("the store's own auto-finish carries the server's completedToday and settings to the offer", async () => {
    let live: FocusRunDTO | null = {
      id: 1,
      taskId: 9,
      taskTitle: "Draft the brief",
      blockId: null,
      startedAt: STARTED_AT,
      endedAt: null,
      plannedMinutes: 1,
      actualMinutes: null,
      outcome: null,
    };
    // The fourth run of the day: this completion is the one that should offer the long break.
    const completedTodaySoFar = 3;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/focus" && !init?.method) return Response.json({ run: live, settings: SETTINGS, completedToday: completedTodaySoFar });
        if (url === "/api/focus/1" && init?.method === "PATCH") {
          const finished: FocusRunDTO = { ...live!, endedAt: new Date().toISOString(), actualMinutes: 1, outcome: "completed" };
          live = null;
          return Response.json({ run: finished, where: [] });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(STARTED_AT));

    render(
      <>
        <FocusChip />
        <BreakOffer />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("Draft the brief")).toBeTruthy();

    // Past the one-minute plan: the store's own tick notices zero and finishes the run itself —
    // nothing in this test calls `finish` or dispatches anything by hand.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(screen.queryByText("Draft the brief")).toBeNull();
    // completedToday (3) + this completion = 4, a multiple of longBreakEvery (4): the long
    // break, in the saved length (21), not the module's own default (15).
    expect(screen.getByText("Take 21 minutes?")).toBeTruthy();
  });
});
