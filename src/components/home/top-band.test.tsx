// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TopBand } from "./top-band";
import type { HomeDTO, PlannerDayDTO } from "@/lib/dto";

const DATE = "2026-09-22";

function day(over: Partial<PlannerDayDTO> = {}): PlannerDayDTO {
  return {
    date: DATE,
    plan: [],
    unfinishedYesterday: [],
    meetings: [],
    calendar: { calendarsSeen: 2, permission: true },
    sources: { owed: [], inbox: [], due: { overdue: [], today: [] }, projects: [], areas: [] },
    capacity: { freeMinutes: 540, plannedMinutes: 120, unestimated: 0, workHours: "09:00-18:00", workingDays: [1, 2, 3, 4, 5], blockedMinutes: 60, unplacedMinutes: 30, drift: null, forecastMinutes: null, leftTodayMinutes: 540 },
    ...over,
  };
}

const NOT_DUE: HomeDTO["review"] = { due: false };
const NO_MEETING_LOAD: HomeDTO["meetingShare"] = { minutes: 0, workingMinutes: 2700 };

function band(
  // `desk` defaults to nothing, so the cases that predate the desk still read as what they are
  // about: a clear desk contributes no figure at all.
  counts: Omit<HomeDTO["counts"], "desk"> & { desk?: number },
  focus: HomeDTO["focus"] = { minutes: 0, running: null },
  review: HomeDTO["review"] = NOT_DUE,
  meetingShare: HomeDTO["meetingShare"] = NO_MEETING_LOAD,
  stalledGoals: HomeDTO["stalledGoals"] = [],
  duePredictions: HomeDTO["duePredictions"] = 0,
) {
  render(
    <TopBand
      day={day()}
      counts={{ ...counts, desk: counts.desk ?? 0 }}
      focus={focus}
      review={review}
      meetingShare={meetingShare}
      stalledGoals={stalledGoals}
      duePredictions={duePredictions}
      onHours={() => {}}
      onWorkingDays={() => {}}
    />,
  );
}

/** Every figure as it reads, paired with where it leads. */
function figures(): { text: string; href: string | null }[] {
  return screen.getAllByRole("link").map((a) => ({ text: a.textContent ?? "", href: a.getAttribute("href") }));
}

afterEach(cleanup);

describe("TopBand", () => {
  it("heads the day with the Planner's numeral and weekday", () => {
    band({ planned: 3, meetings: 2, inbox: 4 });
    expect(screen.getByText("22")).toBeTruthy();
    expect(screen.getByText("Tuesday")).toBeTruthy();
  });

  it("says the capacity in the Planner's own line, with the hours chip", () => {
    band({ planned: 3, meetings: 2, inbox: 4 });
    expect(screen.getByText(/left today/).textContent).toBe("2h planned · 9h left today · 1h blocked · 30m unplaced · 2 meetings");
    expect(screen.getByRole("button", { name: "Hours 09:00-18:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Days Mon-Fri" })).toBeTruthy();
  });

  it("leaves the one region that speaks up to Now", () => {
    band({ planned: 3, meetings: 2, inbox: 4 });
    // Spec §5: the capacity line repeats the figure under it, so on Home it does not re-announce.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("counts the plan, the meetings and the inbox, each a link to its view", () => {
    band({ planned: 3, meetings: 2, inbox: 4 });
    expect(figures()).toEqual([
      { text: "3 planned", href: "/planner" },
      { text: "2 meetings", href: "/planner/meetings" },
      { text: "4 in the inbox", href: "/inbox" },
    ]);
  });

  it("says nothing is there rather than counting to zero", () => {
    band({ planned: 0, meetings: 0, inbox: 0 });
    expect(figures().map((f) => f.text)).toEqual(["Nothing planned", "No meetings", "Inbox clear"]);
  });

  it("counts one of a thing in the singular", () => {
    band({ planned: 1, meetings: 1, inbox: 1 });
    expect(figures().map((f) => f.text)).toEqual(["1 planned", "1 meeting", "1 in the inbox"]);
  });

  it("says nothing focused yet rather than counting to zero", () => {
    band({ planned: 3, meetings: 2, inbox: 4 });
    expect(screen.getByText("Nothing focused yet")).toBeTruthy();
  });

  it("names the day's booked minutes beside the counts, as plain text rather than a link", () => {
    band({ planned: 3, meetings: 2, inbox: 4 }, { minutes: 80, running: null });
    const line = screen.getByText("1h 20m focused");
    expect(line.tagName).toBe("LI");
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("carries one quiet line to the review when the week is due for one", () => {
    band({ planned: 3, meetings: 2, inbox: 4 }, undefined, { due: true });
    const link = screen.getByRole("link", { name: "Review your week" });
    expect(link.getAttribute("href")).toBe("/review");
  });

  it("says nothing at all once the week already has a review", () => {
    band({ planned: 3, meetings: 2, inbox: 4 }, undefined, { due: false });
    expect(screen.queryByText("Review your week")).toBeNull();
  });

  it("links this week's meeting load to the audit, when there is one", () => {
    band({ planned: 3, meetings: 2, inbox: 4 }, undefined, undefined, { minutes: 210, workingMinutes: 2700 });
    const link = screen.getByRole("link", { name: "3h 30m in meetings this week" });
    expect(link.getAttribute("href")).toBe("/meetings/audit");
  });

  it("says nothing about meetings this week rather than a zero", () => {
    band({ planned: 3, meetings: 2, inbox: 4 }, undefined, undefined, { minutes: 0, workingMinutes: 2700 });
    expect(screen.queryByText(/in meetings this week/)).toBeNull();
  });

  it("names a stalled goal and links it to Goals, singular and plural", () => {
    band({ planned: 3, meetings: 2, inbox: 4 }, undefined, undefined, undefined, [{ id: 1, title: "Ship the docs" }]);
    const one = screen.getByRole("link", { name: "1 goal stalled" });
    expect(one.getAttribute("href")).toBe("/goals");
    cleanup();
    band({ planned: 3, meetings: 2, inbox: 4 }, undefined, undefined, undefined, [
      { id: 1, title: "Ship the docs" },
      { id: 2, title: "Launch v2" },
    ]);
    expect(screen.getByRole("link", { name: "2 goals stalled" })).toBeTruthy();
  });

  it("says nothing about stalled goals when there are none", () => {
    band({ planned: 3, meetings: 2, inbox: 4 });
    expect(screen.queryByText(/stalled/)).toBeNull();
  });
});

describe("the week line's calls to score", () => {
  it("names how many calls are waiting to be scored and links to the log", () => {
    band({ planned: 0, meetings: 0, inbox: 0 }, undefined, undefined, undefined, [], 3);
    expect(screen.getByRole("link", { name: "3 calls to score" }).getAttribute("href")).toBe("/log");
  });

  /** A log with nothing overdue is not something to fix, so it drops off the line entirely
   *  rather than reading "0 calls to score". */
  it("says nothing when none is overdue", () => {
    band({ planned: 0, meetings: 0, inbox: 0 }, undefined, undefined, undefined, [], 0);
    expect(screen.queryByText(/to score/)).toBeNull();
  });
});

describe("the desk", () => {
  it("carries one line to the desk when something is waiting there", () => {
    band({ planned: 0, meetings: 0, inbox: 0, desk: 3 });
    const link = screen.getByRole("link", { name: "3 on the desk" });
    expect(link.getAttribute("href")).toBe("/desk");
  });

  /** A clear desk is not a figure, it is the absence of one. */
  it("says nothing at all about a clear desk", () => {
    band({ planned: 0, meetings: 0, inbox: 0, desk: 0 });
    expect(screen.queryByText(/on the desk/)).toBeNull();
  });

  it("never shows the cards themselves: Home points at the desk, it is not the desk", () => {
    band({ planned: 0, meetings: 0, inbox: 0, desk: 2 });
    expect(screen.queryByRole("button", { name: /Reaffirm|Re-estimate|File it/ })).toBeNull();
  });
});
