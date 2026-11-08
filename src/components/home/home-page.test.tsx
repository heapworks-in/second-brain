// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { HomePage } from "./home-page";
import { resetFocusStore } from "../focus/focus-store";
import type { HomeDTO, PlanTaskDTO } from "@/lib/dto";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, refresh: () => {} }), usePathname: () => "/" }));

const DATE = "2026-09-22";

const planTask = (id: number, title: string): PlanTaskDTO => ({
  id, title, notes: "", status: "open", priority: "normal", dueDate: null, containerId: null, sourceItemId: null,
  estimateMinutes: 60, sessionMinutes: null, blocks: [], goals: [], spentMinutes: 0, likeThisMinutes: null, completedAt: null, sortOrder: 0, createdAt: "", updatedAt: "", planId: id,
});

function payload(over: Partial<HomeDTO> = {}): HomeDTO {
  return {
    date: DATE,
    today: DATE,
    generatedAt: "2026-09-22T12:00:00.000Z",
    day: {
      date: DATE,
      plan: [planTask(1, "Write the brief")],
      unfinishedYesterday: [],
      meetings: [],
      calendar: { calendarsSeen: 2, permission: true },
      sources: { inbox: [], due: { overdue: [], today: [] }, projects: [], areas: [] },
      capacity: { freeMinutes: 540, plannedMinutes: 60, unestimated: 0, workHours: "09:00-18:00", workingDays: [1, 2, 3, 4, 5], blockedMinutes: 0, unplacedMinutes: 60, drift: null, forecastMinutes: null, leftTodayMinutes: 540 },
    },
    counts: { planned: 1, meetings: 0, inbox: 2, desk: 0 },
    now: null,
    next: [],
    projects: [{ id: 4, name: "Launch", slug: "launch", open: 2, done: 2, nextTask: null, deadline: null, updatedAt: "2026-09-21T09:00:00.000Z" }],
    recent: [{ id: 9, type: "note", title: "Kickoff notes", updatedAt: "2026-09-22T10:00:00.000Z", status: "ready" }],
    activity: { activeMs: 3_600_000, top: [{ label: "Code", ms: 3_600_000 }] },
    focus: { minutes: 0, running: null },
    review: { due: false },
    meetingShare: { minutes: 0, workingMinutes: 2700 },
    stalledGoals: [],
    duePredictions: 0,
    ...over,
  };
}

type FetchCall = [string, RequestInit | undefined];

/** Answers Home and the recorder; every other request is a 404 so it cannot be mistaken for one. */
function stubHome(body: () => HomeDTO) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/home") return Response.json(body());
    if (url === "/api/meetings/recorder") return Response.json({ state: "idle", missing: [] });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const homeCalls = (fetchMock: ReturnType<typeof stubHome>) =>
  (fetchMock.mock.calls as unknown as FetchCall[]).filter(([input]) => String(input) === "/api/home");
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.unstubAllGlobals();
  nav.push.mockClear();
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

describe("HomePage", () => {
  it("draws the day the payload describes, section by section", () => {
    stubHome(payload);
    render(<HomePage initial={payload()} />);
    expect(screen.getByRole("link", { name: "1 planned" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Launch" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Kickoff notes" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Activity" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the Planner" }).getAttribute("href")).toBe("/planner");
  });

  it("leaves the morning ritual to the Planner entirely", async () => {
    stubHome(payload);
    // A day with nothing planned and something carried over is exactly the morning the
    // Planner would walk through; Home no longer embeds any of that walk, only the door to it.
    render(<HomePage initial={payload({ day: { ...payload().day, plan: [], unfinishedYesterday: [planTask(3, "Yesterday's thing")] } })} />);
    await settle(20);
    expect(screen.queryByRole("list", { name: "Plan the day" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Carry over" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open the Planner" }).getAttribute("href")).toBe("/planner");
  });

  it("reads Home back once when two changes land in the same interaction", async () => {
    const fetchMock = stubHome(payload);
    render(<HomePage initial={payload()} />);
    fireEvent(window, new Event("sb:plan-changed"));
    fireEvent(window, new Event("sb:tasks-changed"));

    await waitFor(() => expect(homeCalls(fetchMock)).toHaveLength(1));
    await settle(120);
    expect(homeCalls(fetchMock)).toHaveLength(1);
  });

  it("listens to everything that can change the day", async () => {
    const fetchMock = stubHome(payload);
    render(<HomePage initial={payload()} />);
    for (const name of ["sb:plan-changed", "sb:tasks-changed", "sb:inbox-changed", "sb:recording-changed", "sb:focus-changed"]) {
      fireEvent(window, new Event(name));
      await settle(80);
    }
    expect(homeCalls(fetchMock)).toHaveLength(5);
  });

  it("drops a refresh the page did not live long enough to make", async () => {
    const fetchMock = stubHome(payload);
    const { unmount } = render(<HomePage initial={payload()} />);
    // The event lands while the page is still up, so the timer is set; unmounting has to clear
    // it, or it fires into a page that is gone.
    fireEvent(window, new Event("sb:plan-changed"));
    unmount();
    await settle(120);
    expect(homeCalls(fetchMock)).toHaveLength(0);
  });

  it("keeps the newest payload when an earlier request answers last", async () => {
    const bodies = [payload({ counts: { planned: 1, meetings: 0, inbox: 5, desk: 0 } }), payload({ counts: { planned: 1, meetings: 0, inbox: 9, desk: 0 } })];
    const gates: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/meetings/recorder") return Response.json({ state: "idle", missing: [] });
        if (url !== "/api/home") return new Response(null, { status: 404 });
        const body = bodies[gates.length];
        await new Promise<void>((resolve) => gates.push(resolve));
        return Response.json(body);
      }),
    );
    render(<HomePage initial={payload()} />);

    fireEvent(window, new Event("sb:inbox-changed"));
    await waitFor(() => expect(gates).toHaveLength(1));
    fireEvent(window, new Event("sb:inbox-changed"));
    await waitFor(() => expect(gates).toHaveLength(2));

    gates[1]();
    await waitFor(() => expect(screen.getByRole("link", { name: "9 in the inbox" })).toBeTruthy());
    gates[0]();
    await settle(20);
    expect(screen.getByRole("link", { name: "9 in the inbox" })).toBeTruthy();
  });
});
