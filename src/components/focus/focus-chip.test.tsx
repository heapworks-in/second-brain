// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { FocusChip } from "./focus-chip";
import { resetFocusStore } from "./focus-store";
import type { FocusRunDTO, FocusSettingsDTO } from "@/lib/dto";

const STARTED_AT = "2026-09-25T10:00:00.000Z";
const SETTINGS: FocusSettingsDTO = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" };

function run(over: Partial<FocusRunDTO> = {}): FocusRunDTO {
  return {
    id: 3,
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

/** Answers the focus poll with the live run, or none, and records every PATCH the chip makes. */
function stubFetch(live: FocusRunDTO | null) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/focus" && !init?.method) return Response.json({ run: live, settings: SETTINGS, completedToday: 0 });
    if (url.startsWith("/api/focus/") && init?.method === "PATCH") {
      return Response.json({ run: { ...(live ?? run()), endedAt: new Date().toISOString(), actualMinutes: 1, outcome: "stopped" }, where: [] });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FocusChip", () => {
  it("renders nothing while no run is live", async () => {
    const fetchMock = stubFetch(null);
    const { container } = render(<FocusChip />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows the task, a counting-down clock, and a way to stop", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(STARTED_AT) + 12_000);
    stubFetch(run());
    render(<FocusChip />);

    expect(await screen.findByText("Draft the brief")).toBeTruthy();
    const clockNode = screen.getByText("24:48");
    expect(clockNode.className).toContain("font-mono");
    expect(clockNode.getAttribute("aria-hidden")).toBe("true");

    const live = screen.getByRole("status");
    expect(live.textContent).toBe("Draft the brief");
    expect(live.contains(clockNode)).toBe(false);

    expect(screen.getByRole("button", { name: "Stop focusing on Draft the brief" })).toBeTruthy();
  });

  it("does not repeat the announcement every second, only the clock beside it ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(STARTED_AT));
    stubFetch(run());
    render(<FocusChip />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const live = screen.getByRole("status");
    expect(live.textContent).toBe("Draft the brief");
    const clockBefore = screen.getByText(/^\d\d:\d\d$/).textContent;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    // The clock moved on; the live region's own text is exactly what it was.
    expect(screen.getByText(/^\d\d:\d\d$/).textContent).not.toBe(clockBefore);
    expect(live.textContent).toBe("Draft the brief");
  });

  it("stops the run on click", async () => {
    const fetchMock = stubFetch(run());
    render(<FocusChip />);
    await screen.findByText("Draft the brief");

    fireEvent.click(screen.getByRole("button", { name: "Stop focusing on Draft the brief" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/focus/3" && init?.method === "PATCH")).toBe(true);
    });
  });
});
