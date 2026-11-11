// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { WeekView } from "./week-view";
import { resetFocusStore } from "../focus/focus-store";
import { PatchTaskBody } from "@/lib/validation";
import type { ActivityMeetingDTO, PlannerWeekDTO, TaskDTO } from "@/lib/dto";

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

function week(): PlannerWeekDTO {
  return {
    start: START,
    drift: null,
    days: Array.from({ length: 7 }, (_, i) => {
      const date = `2026-09-${String(21 + i).padStart(2, "0")}`;
      // Monday sits inside its hours; Tuesday is overbooked, so the two tones are both on screen.
      const plannedMinutes = date === START ? 75 : date === "2026-09-22" ? 600 : 0;
      // 2026-09-21 is a Monday, so the first five days (Mon-Fri) are working days and the last
      // two (Sat, Sun) are not — the payload zeroes a non-working day's capacity across the
      // board, the same way the server does, but `WeekView` reads `working` directly rather
      // than infer it from zeros.
      const working = i < 5;
      return {
        date,
        working,
        meetings: [],
        due: date === START ? [task] : [],
        // `leftTodayMinutes` is what the column actually reads; it matches `freeMinutes` here
        // because none of these fixtures is testing the clock — the case where they differ has
        // its own test below.
        capacity: { freeMinutes: working ? 540 : 0, plannedMinutes, blockedMinutes: 0, forecastMinutes: null, leftTodayMinutes: working ? 540 : 0 },
      };
    }),
  };
}

function mount(): { fetchMock: ReturnType<typeof vi.fn>; onRefresh: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: task.id }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const onRefresh = vi.fn();
  render(<WeekView week={week()} today={TODAY} onRefresh={onRefresh} />);
  // The store makes one `/api/focus` call for the whole page on mount, not one per row; cleared
  // so the assertions below only see the calls a test's own action makes.
  fetchMock.mockClear();
  return { fetchMock, onRefresh };
}

/** The column a weekday name sits in: the pane the drop handler is hung on. */
function column(weekday: string): HTMLElement {
  return screen.getByText(weekday).closest(".pane") as HTMLElement;
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

describe("WeekView", () => {
  it("re-dates a task dropped on another column", () => {
    const { fetchMock } = mount();
    fireEvent.drop(column("Wed"), { dataTransfer: { getData: () => String(task.id) } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/tasks/${task.id}`);
    expect(init.method).toBe("PATCH");
    const body: unknown = JSON.parse(String(init.body));
    expect(body).toEqual({ dueDate: "2026-09-23" });
    // The column sends what the route accepts, not something the route would 400.
    expect(PatchTaskBody.safeParse(body).success).toBe(true);
  });

  it("marks a day that has time blocked on it", () => {
    const w = week();
    w.days[1].capacity.blockedMinutes = 80;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    render(<WeekView week={w} today={TODAY} onRefresh={vi.fn()} />);
    const dot = within(column("Tue")).getByRole("img", { name: "1h 20m blocked" });
    expect(dot.getAttribute("title")).toBe("1h 20m blocked");
    // A day with nothing blocked carries no dot at all.
    expect(within(column("Wed")).queryByRole("img", { name: /blocked/ })).toBeNull();
  });

  it("ignores a drop that carries no task", () => {
    const { fetchMock } = mount();
    fireEvent.drop(column("Wed"), { dataTransfer: { getData: () => "" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says what each day already holds against the time it has", () => {
    mount();
    expect(within(column("Mon")).getByText("1h 15m / 9h")).toBeTruthy();
  });

  it("colours a day that is over its hours", () => {
    mount();
    expect(within(column("Mon")).getByText("1h 15m / 9h").className).toContain("text-fg-muted");
    expect(within(column("Tue")).getByText("10h / 9h").className).toContain("text-warn");
  });

  // F1: the Day view's line and meter both judge a day by `overBasis` — the forecast when one
  // exists, never the bare plan — and the Week was still colouring by the bare plan alone, so
  // the same day could read calm here and overrun there. `capacityTone` reads whichever figure
  // is truly bigger, so a low `plannedMinutes` with a `forecastMinutes` scaled past the window
  // must colour by the forecast, not slip through as "fg-muted" on the strength of the plan.
  it("colours a column by the forecast, not the bare plan, once the week has one (F1)", () => {
    const w = week();
    w.drift = 2;
    // Monday: 75 planned (inside its 9h window) but a forecast of 700 (75 * drift-ish figure,
    // set directly here) blows well past it — the bare plan alone would read calm.
    w.days[0].capacity.forecastMinutes = 700;
    render(<WeekView week={w} today={TODAY} onRefresh={vi.fn()} />);
    const mon = within(column("Mon")).getByText("1h 15m / 9h");
    expect(mon.className).not.toContain("text-fg-muted");
    expect(mon.className).toContain("text-danger");
  });

  it("still colours by the bare plan when the week has no drift to forecast with", () => {
    const w = week();
    w.drift = null;
    w.days[0].capacity.forecastMinutes = 700; // never read: null drift means no forecast at all
    render(<WeekView week={w} today={TODAY} onRefresh={vi.fn()} />);
    expect(within(column("Mon")).getByText("1h 15m / 9h").className).toContain("text-fg-muted");
  });

  it("shows a non-working day as a quiet gap: the date, and nothing about capacity", () => {
    mount();
    const sat = column("Sat");
    // The date and weekday are still there.
    expect(within(sat).getByText("26")).toBeTruthy();
    expect(within(sat).getByText("Sat")).toBeTruthy();
    // Nothing about capacity: not a figure, not "0h", not a blocked dot.
    expect(within(sat).queryByText(/\/ /)).toBeNull();
    expect(within(sat).queryByText(/0h/)).toBeNull();
    expect(within(sat).queryByRole("img", { name: /blocked/ })).toBeNull();
    // F6: a non-working day with nothing on it is a quiet gap, not a card that still finds
    // something to say — "Nothing yet" belongs to a working day nobody has planned.
    expect(within(sat).queryByText("Nothing yet")).toBeNull();
  });

  it("leaves an empty working day empty, rather than saying so seven times", () => {
    mount();
    // Wednesday: working, no meetings, no due tasks. A column with nothing in it already reads
    // as having nothing in it; the figure and the sentence were noise around the days that do.
    const wed = within(column("Wed"));
    expect(wed.queryByText("Nothing yet")).toBeNull();
    expect(wed.queryByText(/0m/)).toBeNull();
    // Monday has something planned, so it still carries its figure.
    expect(within(column("Mon")).getByText(/1h 15m \/ 9h/)).toBeTruthy();
  });

  it("keeps the figure on today even with nothing planned: 'what is left' is a live question", () => {
    const w = week();
    w.days[2].capacity.plannedMinutes = 0;
    render(<WeekView week={w} today="2026-09-23" onRefresh={vi.fn()} />);
    expect(within(column("Wed")).getByText(/0m \/ 9h/)).toBeTruthy();
  });

  /** A subscribed holiday calendar puts an all-day entry in most weeks. As a row it costs the
   * same height as a real meeting; as a chip it stops competing with one. */
  it("shows an all-day entry as a chip, never as a row with a time", () => {
    const w = week();
    w.days[2].meetings = [meeting({ id: 5, title: "Chhath Puja", allDay: true, attendees: 0 })];
    render(<WeekView week={w} today={TODAY} onRefresh={vi.fn()} />);
    const wed = within(column("Wed"));
    expect(wed.getByText("Chhath Puja")).toBeTruthy();
    expect(wed.queryByText("All day")).toBeNull();
    expect(wed.queryByRole("list")).toBeNull();
  });

  it("offers the day itself once a column holds more meetings than it can read", () => {
    const w = week();
    w.days[2].meetings = Array.from({ length: 7 }, (_, i) =>
      meeting({ id: 100 + i, title: `Sync ${i + 1}`, startsAt: `2026-09-23T0${i + 2}:00:00.000Z` }),
    );
    render(<WeekView week={w} today={TODAY} onRefresh={vi.fn()} />);
    const wed = within(column("Wed"));
    expect(wed.getAllByRole("button").filter((b) => /Sync/.test(b.textContent ?? ""))).toHaveLength(4);
    const more = wed.getByRole("link", { name: "3 more" });
    expect(more.getAttribute("href")).toBe("/planner?date=2026-09-23");
  });

  it("keeps the blocked dot off a non-working day even when it has blocked minutes", () => {
    const w = week();
    w.days[5].capacity.blockedMinutes = 80;
    render(<WeekView week={w} today={TODAY} onRefresh={vi.fn()} />);
    expect(within(column("Sat")).queryByRole("img", { name: /blocked/ })).toBeNull();
  });

  it("reads today's own leftTodayMinutes, not the whole-window freeMinutes", () => {
    // Tuesday (today) has a nine-hour window, but only 2h of it is left — the figure the
    // column shows is the one that knows what time it is, not the one that never asks.
    const w = week();
    w.days[1].capacity.leftTodayMinutes = 120;
    render(<WeekView week={w} today={TODAY} onRefresh={vi.fn()} />);
    expect(within(column("Tue")).getByText("10h / 2h")).toBeTruthy();
    expect(within(column("Tue")).queryByText(/9h/)).toBeNull();
  });

  it("reads a past day's whole window, not its zeroed-out leftTodayMinutes (N2)", () => {
    // Monday is before today (Tuesday): the server reports its leftTodayMinutes as 0, since
    // "time left" is a live figure about now and Monday's now is long gone. A past week column
    // is a different question — what was planned against what the day had — and Monday
    // genuinely had nine hours, so the column reads `freeMinutes`, not a zero that would paint
    // every past working day red.
    const w = week();
    w.days[0].capacity.leftTodayMinutes = 0;
    render(<WeekView week={w} today={TODAY} onRefresh={vi.fn()} />);
    expect(within(column("Mon")).getByText("1h 15m / 9h")).toBeTruthy();
    expect(within(column("Mon")).queryByText(/0m/)).toBeNull();
    expect(within(column("Mon")).getByText("1h 15m / 9h").className).not.toContain("text-danger");
  });

  it("plans from the week on screen rather than from today", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Task actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Plan for" }));
    const days = screen.getByRole("menu", { name: "Plan for" });
    expect((days.querySelector('[role="menuitem"]') as HTMLElement).textContent).toBe("Monday 21");
  });
});
