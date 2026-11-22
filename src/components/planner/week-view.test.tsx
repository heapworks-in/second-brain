// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { WeekView } from "./week-view";
import { weekHours } from "./week-grid";
import { resetFocusStore } from "../focus/focus-store";
import { PatchTaskBody } from "@/lib/validation";
import type { ActivityMeetingDTO, BlockDTO, PlannerWeekDTO, PlanTaskDTO, TaskDTO } from "@/lib/dto";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, refresh: () => {} }), usePathname: () => "/planner/week" }));

const START = "2026-09-21";
const TODAY = "2026-09-22";

const task: TaskDTO = {
  id: 4, title: "Draft email", notes: "", status: "open", priority: "normal", dueDate: START, containerId: null, sourceItemId: null, requester: null, askedOn: null,
  estimateMinutes: null, sessionMinutes: null, blocks: [], goals: [], spentMinutes: 0, likeThisMinutes: null, completedAt: null, sortOrder: 0, createdAt: "", updatedAt: "",
};

function meeting(over: Partial<ActivityMeetingDTO> & { id: number; title: string }): ActivityMeetingDTO {
  return {
    startsAt: "2026-09-23T09:00:00.000Z", endsAt: "2026-09-23T10:00:00.000Z", attendees: 3, hasCallLink: false, interview: false,
    scheduledMs: 3_600_000, actualMs: 0, itemId: null, organizer: "", attendeeNames: [], location: "", joinUrl: null, allDay: false,
    status: "accepted", calendarTitle: "Work", noRecord: false, seriesId: null, decision: "going", decisionNote: "", seriesDecision: null, containerId: null, containerFromSeries: false,
    ...over,
  };
}

/** A planned task holding one session, which is what puts it on the grid rather than the rail. */
function planned(over: { id: number; title: string; startsAt: string; minutes: number }): PlanTaskDTO {
  const block: BlockDTO = { id: over.id * 100, taskId: over.id, startsAt: over.startsAt, minutes: over.minutes, spentMinutes: 0 };
  return { ...task, id: over.id, title: over.title, planId: over.id, blocks: [block] };
}

function week(): PlannerWeekDTO {
  return {
    start: START,
    workHours: "09:00-18:00",
    drift: null,
    days: Array.from({ length: 7 }, (_, i) => {
      const date = `2026-09-${String(21 + i).padStart(2, "0")}`;
      const plannedMinutes = date === START ? 75 : date === "2026-09-22" ? 600 : 0;
      // 2026-09-21 is a Monday, so Mon-Fri are working days and the weekend is not.
      const working = i < 5;
      return {
        date,
        working,
        meetings: [],
        plan: [],
        due: date === START ? [task] : [],
        capacity: {
          freeMinutes: working ? 540 : 0,
          plannedMinutes: working ? plannedMinutes : 0,
          blockedMinutes: 0,
          forecastMinutes: null,
          leftTodayMinutes: working ? 540 : 0,
        },
      };
    }),
  };
}

function mount(w: PlannerWeekDTO = week()): { fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: task.id }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<WeekView week={w} today={TODAY} onRefresh={vi.fn()} />);
  fetchMock.mockClear();
  return { fetchMock };
}

const day = (date: string): HTMLElement => screen.getByTestId(`week-day-${date}`);

/** Where a block sits and how tall it is, in pixels down the column. */
function box(el: HTMLElement): { top: number; height: number } {
  return { top: Number.parseFloat(el.style.top), height: Number.parseFloat(el.style.height) };
}

beforeEach(() => {
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.unstubAllGlobals();
  nav.push.mockClear();
});

describe("weekHours", () => {
  it("covers the working day when nothing falls outside it", () => {
    expect(weekHours(week().days, "09:00-18:00")).toEqual({ dayStart: 9, dayEnd: 18 });
  });

  /* One range for all seven columns, never one each: columns whose hours differ cannot be read
   * across, which is the only thing a week view is for. */
  it("widens for an early meeting, and widens every column with it", () => {
    const w = week();
    w.days[2].meetings = [meeting({ id: 1, title: "Standup", startsAt: "2026-09-23T07:30:00", endsAt: "2026-09-23T08:00:00" })];
    expect(weekHours(w.days, "09:00-18:00").dayStart).toBe(7);
  });

  it("widens for a session running past the end of the day", () => {
    const w = week();
    w.days[0].plan = [planned({ id: 9, title: "Late push", startsAt: "2026-09-21T19:00:00", minutes: 90 })];
    expect(weekHours(w.days, "09:00-18:00").dayEnd).toBe(21);
  });

  it("ignores an all-day event, which has no hour to widen to", () => {
    const w = week();
    w.days[1].meetings = [meeting({ id: 2, title: "Holiday", allDay: true, startsAt: "2026-09-22T00:00:00", endsAt: "2026-09-23T00:00:00" })];
    expect(weekHours(w.days, "09:00-18:00")).toEqual({ dayStart: 9, dayEnd: 18 });
  });
});

describe("WeekView", () => {
  it("re-dates a task dropped on another column", () => {
    const { fetchMock } = mount();
    fireEvent.drop(day("2026-09-23"), { dataTransfer: { getData: () => String(task.id) } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/tasks/${task.id}`);
    expect(init.method).toBe("PATCH");
    const body: unknown = JSON.parse(String(init.body));
    expect(body).toEqual({ dueDate: "2026-09-23" });
    expect(PatchTaskBody.safeParse(body).success).toBe(true);
  });

  /* The whole point of the grid: a meeting at nine and a meeting at five no longer look alike.
   * 09:00 is the top of the column and every later hour is 60 minutes further down, scaled. */
  it("puts a meeting where its time actually falls", () => {
    const w = week();
    w.days[2].meetings = [meeting({ id: 1, title: "Design review", startsAt: "2026-09-23T14:00:00", endsAt: "2026-09-23T15:30:00" })];
    mount(w);

    const block = within(day("2026-09-23")).getByTitle("Design review, 14:00–15:30");
    // Five hours past the 09:00 start, ninety minutes long, at 0.6px a minute.
    expect(box(block)).toEqual({ top: 5 * 60 * 0.6, height: 90 * 0.6 });
  });

  it("puts a planned session on the grid too, and sends it to that day", () => {
    const w = week();
    w.days[0].plan = [planned({ id: 9, title: "Write the spec", startsAt: "2026-09-21T11:00:00", minutes: 60 })];
    mount(w);

    const block = within(day(START)).getByTitle("Write the spec, 11:00–12:00");
    expect(box(block)).toEqual({ top: 2 * 60 * 0.6, height: 60 * 0.6 });
    expect(block.getAttribute("href")).toBe(`/planner?date=${START}`);
  });

  /* A session and a meeting at the same hour are laid out together, so neither hides under the
   * other -- the failure that makes an overbooked day look free. */
  it("shares the column between a session and a meeting that overlap", () => {
    const w = week();
    w.days[2].meetings = [meeting({ id: 1, title: "Design review", startsAt: "2026-09-23T11:00:00", endsAt: "2026-09-23T12:00:00" })];
    w.days[2].plan = [planned({ id: 9, title: "Write the spec", startsAt: "2026-09-23T11:30:00", minutes: 60 })];
    mount(w);

    const column = day("2026-09-23");
    const meet = within(column).getByTitle("Design review, 11:00–12:00");
    const session = within(column).getByTitle("Write the spec, 11:30–12:30");
    // Two columns of equal width, the second offset by half.
    expect(meet.style.width).toBe("calc(50% - 3px)");
    expect(meet.style.left).toBe("calc(0% + 2px)");
    expect(session.style.width).toBe("calc(50% - 3px)");
    expect(session.style.left).toBe("calc(50% + 2px)");
  });

  /* Nothing without a time pretends to a position in the grid. An all-day event placed at
   * midnight would be a block the height of the whole column. */
  it("keeps all-day events and due tasks out of the grid", () => {
    const w = week();
    w.days[1].meetings = [meeting({ id: 2, title: "Holiday", allDay: true, startsAt: "2026-09-22T00:00:00", endsAt: "2026-09-23T00:00:00" })];
    mount(w);

    expect(within(day("2026-09-22")).queryByTitle(/Holiday/)).toBeNull();
    expect(screen.getByTitle("Holiday")).toBeTruthy();
    expect(screen.getByTitle("Due: Draft email")).toBeTruthy();
    expect(within(day(START)).queryByTitle(/Draft email/)).toBeNull();
  });

  it("offers the day itself once a rail holds more than it can read", () => {
    const w = week();
    w.days[1].meetings = [1, 2, 3, 4].map((id) =>
      meeting({ id, title: `Holiday ${id}`, allDay: true, startsAt: "2026-09-22T00:00:00", endsAt: "2026-09-23T00:00:00" }),
    );
    mount(w);

    expect(screen.getByText("1 more").getAttribute("href")).toBe("/planner?date=2026-09-22");
    expect(screen.queryByTitle("Holiday 4")).toBeNull();
  });

  /* Seven copies of "0m / 9h" was six lines of arithmetic around the one day with anything on
   * it. The load is a bar now, and a day with nothing planned draws none. */
  it("shows a load bar only where something is planned", () => {
    mount();
    expect(within(screen.getByLabelText("1h 15m planned")).getByTitle("1h 15m planned")).toBeTruthy();
    // Wednesday has nothing planned: the bar's track is there, its fill is not.
    expect(within(screen.getAllByLabelText("0m planned")[0]).queryByTitle(/planned/)).toBeNull();
  });

  it("says a weekend is not a working day rather than claiming it is empty", () => {
    mount();
    expect(screen.getAllByLabelText("Not a working day")).toHaveLength(2);
  });

  it("says when the whole week holds nothing at all", () => {
    const w = week();
    w.days[0].due = [];
    mount(w);
    expect(screen.getByText("Nothing booked this week.")).toBeTruthy();
  });
});
