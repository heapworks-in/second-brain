// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { NowNext } from "./now-next";
import { resetFocusStore } from "../focus/focus-store";
import type { FocusRunDTO, FocusSettingsDTO, HomeDTO, HomeItemDTO, PlannerDayDTO, PlanTaskDTO, RecorderStatusDTO } from "@/lib/dto";

const DATE = "2026-09-22";
const NO_FOCUS: HomeDTO["focus"] = { minutes: 0, running: null };
const FOCUS_SETTINGS: FocusSettingsDTO = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" };

const planTask = (over: Partial<PlanTaskDTO> = {}): PlanTaskDTO => ({
  id: 7, title: "Write the brief", notes: "", status: "open", priority: "normal", dueDate: null, containerId: null, sourceItemId: null,
  estimateMinutes: 60, sessionMinutes: null, blocks: [], goals: [], spentMinutes: 0, likeThisMinutes: null, completedAt: null, sortOrder: 0, createdAt: "", updatedAt: "", planId: 1,
  ...over,
});

function day(over: Partial<PlannerDayDTO> = {}): PlannerDayDTO {
  return {
    date: DATE,
    plan: [],
    unfinishedYesterday: [],
    meetings: [],
    calendar: { calendarsSeen: 2, permission: true },
    sources: { inbox: [], due: { overdue: [], today: [] }, projects: [], areas: [] },
    capacity: { freeMinutes: 540, plannedMinutes: 60, unestimated: 0, workHours: "09:00-18:00", workingDays: [1, 2, 3, 4, 5], blockedMinutes: 0, unplacedMinutes: 60, drift: null, forecastMinutes: null, leftTodayMinutes: 540 },
    ...over,
  };
}

const meetingNow: HomeItemDTO = { kind: "meeting", title: "Design review", startsAt: "2026-09-22T10:00:00", endsAt: "2026-09-22T11:00:00", meetingId: 3, joinUrl: "https://meet.example/abc" };
const sessionNow: HomeItemDTO = { kind: "session", title: "Write the brief", startsAt: "2026-09-22T10:00:00", endsAt: "2026-09-22T10:45:00", taskId: 7, blockId: 12 };

function focusRun(over: Partial<FocusRunDTO> = {}): FocusRunDTO {
  return {
    id: 5,
    taskId: 7,
    taskTitle: "Write the brief",
    blockId: null,
    startedAt: "2026-09-22T10:00:00.000Z",
    endedAt: null,
    plannedMinutes: 25,
    actualMinutes: null,
    outcome: null,
    ...over,
  };
}

/** Answers the recorder and the focus store's own poll with the state given, and records every
 * other request. */
function stub(recorder: Partial<RecorderStatusDTO> = {}, place?: { placed: number; unplacedMinutes: number }, live: FocusRunDTO | null = null) {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/meetings/recorder") return Response.json({ state: "idle", missing: [], ...recorder } satisfies RecorderStatusDTO);
      if (url === "/api/plan/place") return Response.json(place ?? { placed: 2, unplacedMinutes: 0 });
      if (url === "/api/focus" && !init?.method) return Response.json({ run: live, settings: FOCUS_SETTINGS, completedToday: 0 });
      if (url.startsWith("/api/focus/") && init?.method === "PATCH") {
        return Response.json({ run: { ...(live ?? focusRun()), endedAt: new Date().toISOString(), actualMinutes: 1, outcome: "stopped" }, where: [] });
      }
      return Response.json({});
    }),
  );
  return calls;
}

/** Every toast raised while the block runs, in order. */
function watchToasts() {
  const seen: { text: string; action?: { label: string } }[] = [];
  const listen = (e: Event) => seen.push((e as CustomEvent<{ text: string; action?: { label: string } }>).detail);
  window.addEventListener("sb:toast", listen);
  return { seen, stop: () => window.removeEventListener("sb:toast", listen) };
}

function mount(props: { now?: HomeItemDTO | null; next?: HomeItemDTO[]; day?: PlannerDayDTO; today?: string; focus?: HomeDTO["focus"] } = {}) {
  render(<NowNext day={props.day ?? day()} today={props.today ?? DATE} now={props.now ?? null} next={props.next ?? []} focus={props.focus ?? NO_FOCUS} />);
}

beforeEach(() => {
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.unstubAllGlobals();
});

describe("NowNext", () => {
  it("says nothing is on when nothing is", () => {
    stub();
    mount();
    expect(screen.getByRole("status").textContent).toContain("Nothing on right now");
  });

  it("puts the meeting in progress in the status region, with its end, Join and Record", async () => {
    stub();
    mount({ now: meetingNow });
    const region = screen.getByRole("status");
    expect(region.textContent).toContain("Design review");
    expect(region.textContent).toContain("Ends 11:00");
    expect(screen.getByRole("link", { name: "Join Design review" }).getAttribute("href")).toBe("https://meet.example/abc");
    await waitFor(() => expect((screen.getByRole("button", { name: "Record Design review" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows the recorder's trouble beside its own, as the meetings list does", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/meetings/recorder") return Response.json({ state: "idle", missing: [] } satisfies RecorderStatusDTO);
        if (url === "/api/meetings/recorder/start") return Response.json({ error: "The recorder helper is not running" }, { status: 409 });
        return Response.json({});
      }),
    );
    mount({ now: meetingNow });
    const record = await screen.findByRole("button", { name: "Record Design review" });
    await waitFor(() => expect((record as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(record);
    // NowNext holds no error of its own here: the line is the recorder's.
    expect(await screen.findByText("The recorder helper is not running")).toBeTruthy();
  });

  it("shows the recorder's own state in place of the Record button while a session runs", async () => {
    stub({ state: "recording", title: "Design review" });
    mount({ now: meetingNow });
    await waitFor(() => expect(screen.getByText("Recording")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Record Design review" })).toBeNull();
  });

  it("gives the session in progress the block's checkbox, which ticks the task off", async () => {
    const calls = stub();
    mount({ now: sessionNow });
    const box = screen.getByRole("checkbox", { name: "Write the brief" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(calls.find((c) => c.url === "/api/tasks/7")).toBeTruthy());
    const call = calls.find((c) => c.url === "/api/tasks/7")!;
    expect(call.method).toBe("PATCH");
    expect(call.body).toEqual({ status: "done" });
  });

  it("shows a live run in place of a running session, with the remaining time and a Stop", async () => {
    stub({}, undefined, focusRun({ startedAt: "2026-09-22T10:00:00.000Z", plannedMinutes: 25 }));
    mount({ now: sessionNow, focus: { minutes: 0, running: focusRun({ startedAt: "2026-09-22T10:00:00.000Z", plannedMinutes: 25 }) } });
    const region = await screen.findByRole("status");
    expect(region.textContent).toContain("Write the brief");
    expect(screen.queryByRole("checkbox", { name: "Write the brief" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop focusing on Write the brief" })).toBeTruthy();
  });

  it("never lets a live run take the slot from a meeting in progress", async () => {
    stub({}, undefined, focusRun());
    mount({ now: meetingNow, focus: { minutes: 0, running: focusRun() } });
    const region = screen.getByRole("status");
    expect(region.textContent).toContain("Design review");
    expect(screen.queryByRole("button", { name: /Stop focusing/ })).toBeNull();
  });

  it("F1: trusts the server payload only until the store's own load lands, then trusts the store alone — even a run that is already gone", async () => {
    // The store's own GET says there is no run; the payload handed to first paint still carries
    // one. Before the store has loaded, the payload is the only honest answer there is.
    stub();
    mount({ now: null, focus: { minutes: 0, running: focusRun() } });
    expect(screen.getByRole("status").textContent).toContain("Write the brief");
    expect(screen.getByRole("button", { name: "Stop focusing on Write the brief" })).toBeTruthy();

    // Once the store's own load lands and says there is no run, that wins — the payload's run is
    // dropped, not shown as a frozen countdown under a Stop button that would send nothing.
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Nothing on right now"));
    expect(screen.queryByRole("button", { name: /Stop focusing/ })).toBeNull();
  });

  it("stops the live run from the Now slot", async () => {
    const calls = stub({}, undefined, focusRun());
    mount({ now: null, focus: { minutes: 0, running: focusRun() } });
    fireEvent.click(await screen.findByRole("button", { name: "Stop focusing on Write the brief" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url === "/api/focus/5" && c.method === "PATCH")).toBe(true);
    });
  });

  it("lists the next two timed things with the time each starts", () => {
    stub();
    mount({
      now: sessionNow,
      next: [
        { kind: "meeting", title: "Standup", startsAt: "2026-09-22T11:30:00", endsAt: "2026-09-22T11:45:00", meetingId: 4 },
        { kind: "session", title: "Read the notes", startsAt: "2026-09-22T14:00:00", endsAt: "2026-09-22T14:25:00", taskId: 8, blockId: 13 },
      ],
    });
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual(["11:30Standup", "14:00Read the notes"]);
  });

  it("offers to fill the day when a planned task has an estimate and nothing is placed", async () => {
    const calls = stub({}, { placed: 2, unplacedMinutes: 0 });
    const toasts = watchToasts();
    try {
      mount({ day: day({ plan: [planTask()] }) });
      expect(screen.getByText("Nothing placed yet")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Place in free slots" }));
      await waitFor(() => expect(calls.find((c) => c.url === "/api/plan/place")).toBeTruthy());
      const call = calls.find((c) => c.url === "/api/plan/place")!;
      expect(call.method).toBe("POST");
      expect(call.body).toEqual({ date: DATE });
      await waitFor(() => expect(toasts.seen.map((t) => t.text)).toEqual(["Placed 2 sessions"]));
    } finally {
      toasts.stop();
    }
  });

  it("offers tomorrow when the day had no room for all of it", async () => {
    stub({}, { placed: 1, unplacedMinutes: 30 });
    const toasts = watchToasts();
    try {
      mount({ day: day({ plan: [planTask()] }) });
      fireEvent.click(screen.getByRole("button", { name: "Place in free slots" }));
      await waitFor(() => expect(toasts.seen).toHaveLength(1));
      expect(toasts.seen[0].text).toBe("Placed 1 session, 30m unplaced");
      expect(toasts.seen[0].action?.label).toBe("Place tomorrow");
    } finally {
      toasts.stop();
    }
  });

  it("says nothing about placing once a session has a place, or with nothing to place", () => {
    stub();
    mount({ day: day({ plan: [planTask({ blocks: [{ id: 1, taskId: 7, startsAt: `${DATE}T09:00:00`, minutes: 60, spentMinutes: 0 }] })] }) });
    expect(screen.queryByRole("button", { name: "Place in free slots" })).toBeNull();
    cleanup();
    mount({ day: day({ plan: [planTask({ estimateMinutes: null })] }) });
    expect(screen.queryByRole("button", { name: "Place in free slots" })).toBeNull();
  });
});
