// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { PlannerDayDTO, TaskDTO } from "@/lib/dto";
import { RitualStrip, ritualDoneKey } from "./ritual-strip";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    /* no storage */
  }
});

const TODAY = "2026-09-23";
let id = 1;
const task = (title: string, dueDate: string | null = null): TaskDTO => ({
  id: id++, title, notes: "", status: "open", priority: "normal", dueDate, containerId: null, sourceItemId: null, requester: null, askedOn: null, completedAt: null,
  sortOrder: 0, estimateMinutes: null, sessionMinutes: null, blocks: [], goals: [], spentMinutes: 0, likeThisMinutes: null, createdAt: "2026-09-22T09:00:00.000Z", updatedAt: "2026-09-22T09:00:00.000Z",
});
const late = task("Late", "2026-09-20");
const due = task("Due", TODAY);
const left = task("Left over");
/** A project with something still to plan, so the morning's last step has a reason to exist. */
const PROJECT = { container: { id: 10, name: "Launch", slug: "launch", kind: "project" as const }, tasks: [task("Ship it")] };

function day(over: Partial<PlannerDayDTO> = {}): PlannerDayDTO {
  return {
    date: TODAY, plan: [], unfinishedYesterday: [left], meetings: [],
    calendar: { calendarsSeen: 1, permission: true },
    sources: { owed: [], inbox: [], due: { overdue: [late], today: [due] }, projects: [PROJECT], areas: [] },
    capacity: { freeMinutes: 540, plannedMinutes: 0, unestimated: 0, workHours: "09:00-18:00", workingDays: [1, 2, 3, 4, 5], blockedMinutes: 0, unplacedMinutes: 0, drift: null, forecastMinutes: null, leftTodayMinutes: 540 },
    ...over,
  };
}
function stub() {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ moved: 1 });
  }));
  return posts;
}

describe("RitualStrip", () => {
  it("walks carry over, due, and projects, then reports done", async () => {
    const posts = stub();
    const onDone = vi.fn();
    const onStarted = vi.fn();
    render(<RitualStrip day={day()} today={TODAY} onStarted={onStarted} onDone={onDone} />);
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0].getAttribute("aria-current")).toBe("step");
    fireEvent.click(screen.getByRole("button", { name: "Carry over" }));
    expect(onStarted).toHaveBeenCalled();
    await waitFor(() => expect(posts[0]).toMatchObject({ url: "/api/plan/carry-over", body: { from: "2026-09-22", to: TODAY } }));
    await waitFor(() => expect(steps[1].getAttribute("aria-current")).toBe("step"));
    fireEvent.click(screen.getByRole("button", { name: "Plan all" }));
    await waitFor(() => expect(posts.slice(1).map((p) => p.body)).toEqual([
      { date: TODAY, taskId: late.id },
      { date: TODAY, taskId: due.id },
    ]));
    const pickerEvents: unknown[] = [];
    window.addEventListener("sb:plan-picker", (e) => pickerEvents.push((e as CustomEvent).detail));
    fireEvent.click(screen.getByRole("button", { name: "Open projects" }));
    expect(pickerEvents).toEqual([{ filter: "projects", focus: true }]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalled();
    expect(localStorage.getItem(ritualDoneKey(TODAY))).toBe("1");
  });

  it("skips steps, and leaves out carry over when yesterday left nothing", () => {
    stub();
    render(<RitualStrip day={day({ unfinishedYesterday: [] })} today={TODAY} onStarted={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Carry over" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getAllByRole("listitem")[1].getAttribute("aria-current")).toBe("step");
  });

  it("leaves the due step out when nothing is due", () => {
    stub();
    const empty = { inbox: [], owed: [], due: { overdue: [], today: [] }, projects: [PROJECT], areas: [] };
    render(<RitualStrip day={day({ sources: empty })} today={TODAY} onStarted={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Plan all" })).toBeNull();
  });

  it("keeps a finished due step on the strip after the day comes back without it", async () => {
    const posts = stub();
    const { rerender } = render(<RitualStrip day={day({ unfinishedYesterday: [] })} today={TODAY} onStarted={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan all" }));
    await waitFor(() => expect(posts).toHaveLength(2));

    // Everything due is on the plan now, so the reloaded day carries none of it.
    const empty = { inbox: [], owed: [], due: { overdue: [], today: [] }, projects: [PROJECT], areas: [] };
    rerender(<RitualStrip day={day({ unfinishedYesterday: [], sources: empty })} today={TODAY} onStarted={vi.fn()} onDone={vi.fn()} />);
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(2);
    expect(steps[0].textContent).toContain("Review what is due");
    // Struck through with the check, not gone: the walk keeps the shape it started with.
    expect(steps[0].querySelector(".line-through")).toBeTruthy();
    expect(steps[0].querySelector(".text-violet")).toBeTruthy();
    expect(steps[1].getAttribute("aria-current")).toBe("step");
  });

  it("plans the oldest overdue first, then what falls due on the day", async () => {
    const posts = stub();
    const older = task("Older", "2026-09-18");
    const sources = { inbox: [], owed: [], due: { overdue: [late, older], today: [due] }, projects: [], areas: [] };
    render(<RitualStrip day={day({ unfinishedYesterday: [], sources })} today={TODAY} onStarted={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Plan all" }));
    await waitFor(() => expect(posts.map((p) => (p.body as { taskId: number }).taskId)).toEqual([older.id, late.id, due.id]));
  });
});
