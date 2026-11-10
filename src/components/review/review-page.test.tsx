// @vitest-environment jsdom
import { StrictMode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ReviewPage, SAVE_ERROR } from "./review-page";
import type { PlanTaskDTO, ReviewDTO } from "@/lib/dto";
import type { ReviewStep } from "@/db/enums";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));

const WEEK = "2026-09-21";
const NEXT_WEEK = "2026-09-28";
const DAYS = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

function payload(over: Partial<ReviewDTO> = {}): ReviewDTO {
  return {
    week: WEEK,
    label: "Week of 21 September 2026",
    days: DAYS,
    today: WEEK,
    asOf: WEEK,
    current: true,
    step: "clear",
    answers: {},
    clear: { inbox: 0, leftover: [] },
    back: { done: 0, dropped: 0, slipped: 0, focusMinutes: 0, focusRuns: 0, meetings: 0, projects: [], predictions: { logged: 0, resolved: 0 }, frozen: false },
    goals: [],
    ahead: { week: NEXT_WEEK, due: [], deadlines: [], meetings: [] },
    savedAt: null,
    ...over,
  };
}

const planTask = (id: number, title: string): PlanTaskDTO => ({
  id,
  title,
  notes: "",
  status: "open",
  priority: "normal",
  dueDate: null,
  containerId: null,
  sourceItemId: null, requester: null, askedOn: null,
  estimateMinutes: null,
  sessionMinutes: null,
  blocks: [],
  goals: [],
  spentMinutes: 0,
  likeThisMinutes: null,
  completedAt: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  planId: id,
});

type Handler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function patchCalls(fn: ReturnType<typeof vi.fn>): { step: ReviewStep; value: unknown }[] {
  return (fn.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][])
    .filter(([input, init]) => String(input) === "/api/review" && init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init!.body)) as { step: ReviewStep; value: unknown });
}

/** Answers `/api/inbox` (InboxProcessor's own fetch, embedded in the Clear pane) and `/api/review`
 * PATCH by merging the saved step into the answers the given payload holds — enough to prove a
 * save round-trips without a real server. Every other request is a 404 so it cannot be mistaken
 * for one that was meant to be answered. */
function stubFetch(current: ReviewDTO) {
  const fn = vi.fn<Handler>(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/inbox")) return Response.json({ count: 0, items: [] });
    if (url === "/api/review" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { week: string; step: ReviewStep; value: string | Record<string, string> };
      current = { ...current, answers: { ...current.answers, [body.step]: body.value }, savedAt: "2026-09-25T12:00:00.000Z" };
      return Response.json(current);
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nav.push.mockClear();
});

describe("ReviewPage", () => {
  it("opens on the step the saved review left off at", async () => {
    stubFetch(payload());
    render(<ReviewPage initial={payload({ step: "back", answers: { clear: "Cleared the inbox out." } })} />);
    expect(screen.getByRole("button", { name: /Look back/ }).getAttribute("aria-current")).toBe("step");
    // The Look back pane's own content is showing, not the Clear pane's.
    expect(screen.getByText("How did the week go")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Inbox" })).toBeNull();
  });

  it("moves forward and back without losing what was typed", async () => {
    stubFetch(payload());
    render(<ReviewPage initial={payload()} />);
    const notes = screen.getByLabelText("Anything to flag before moving on") as HTMLTextAreaElement;
    fireEvent.change(notes, { target: { value: "Inbox is empty, three tasks left over." } });
    expect(notes.value).toBe("Inbox is empty, three tasks left over.");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("How did the week go")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByLabelText("Anything to flag before moving on")).toBeTruthy());
    expect((screen.getByLabelText("Anything to flag before moving on") as HTMLTextAreaElement).value).toBe("Inbox is empty, three tasks left over.");
  });

  it("names every step in the nav, and gives the answered one — not the open one — an accessible mark, without touching the untouched ones", () => {
    stubFetch(payload());
    render(<ReviewPage initial={payload({ step: "back", answers: { clear: "Cleared the inbox out." } })} />);
    for (const label of ["Clear the decks", "Look back", "Goals", "Look ahead"]) {
      expect(screen.getAllByRole("button", { name: new RegExp(label) }).length).toBeGreaterThan(0);
    }
    // Answered but not the one open: the mark is in the accessible name itself, not only in a
    // decorative tick a screen reader has no reason to describe.
    const clearButton = screen.getByRole("button", { name: "Clear the decks, answered" });
    expect(clearButton.getAttribute("aria-current")).toBeNull();
    // Open but not yet answered: current, no "answered" mark.
    const backButton = screen.getByRole("button", { name: "Look back" });
    expect(backButton.getAttribute("aria-current")).toBe("step");
    // Untouched: neither current nor answered.
    const goalsButton = screen.getByRole("button", { name: "Goals" });
    expect(goalsButton.getAttribute("aria-current")).toBeNull();
  });

  it("says so when the week has nothing to show rather than rendering empty panes", async () => {
    stubFetch(payload());
    render(<ReviewPage initial={payload()} />);
    expect(screen.getByText("Nothing was left open this week.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Nothing was planned this week.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("No active goals to check in on.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Nothing due, booked, or planned for next week yet.")).toBeTruthy());
  });

  it("shows the inbox count on the step that owns it", () => {
    stubFetch(payload());
    render(<ReviewPage initial={payload({ clear: { inbox: 3, leftover: [] } })} />);
    expect(screen.getByText("3", { selector: "span" })).toBeTruthy();
  });

  it("does not save an untouched step just by tabbing through it, and does not mark it answered", async () => {
    const fn = stubFetch(payload());
    render(<ReviewPage initial={payload()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("Nothing due, booked, or planned for next week yet.")).toBeTruthy());
    expect(patchCalls(fn)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByLabelText("Anything to flag before moving on")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /answered/ })).toBeNull();
  });

  it("queues a second save for the same step behind the first, and sends whatever was typed most recently", async () => {
    let current = payload();
    let releaseFirst: (() => void) | null = null;
    let patchCount = 0;
    const fn = vi.fn<Handler>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/inbox")) return Response.json({ count: 0, items: [] });
      if (url === "/api/review" && init?.method === "PATCH") {
        patchCount += 1;
        const body = JSON.parse(String(init.body)) as { step: ReviewStep; value: string };
        if (patchCount === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        current = { ...current, answers: { ...current.answers, [body.step]: body.value } };
        return Response.json(current);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fn);

    render(<ReviewPage initial={payload()} />);
    fireEvent.change(screen.getByLabelText("Anything to flag before moving on"), { target: { value: "first draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // save #1 for "clear" — held
    await waitFor(() => expect(patchCount).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Back" })); // "back" is untouched: no request
    fireEvent.change(screen.getByLabelText("Anything to flag before moving on"), { target: { value: "second draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // save #2 for "clear" — queued behind #1

    expect(patchCount).toBe(1); // still queued, not yet sent
    releaseFirst!();
    await waitFor(() => expect(patchCount).toBe(2));

    const calls = patchCalls(fn);
    expect(calls[0]).toMatchObject({ step: "clear", value: "first draft" });
    // The queued save read the draft at the moment it actually ran, not the moment it was
    // enqueued — so the keystroke typed while the first save was in flight is not lost.
    expect(calls[1]).toMatchObject({ step: "clear", value: "second draft" });
  });

  it("keeps a failed step's error until that step itself saves, not wiped by another step's success", async () => {
    let current = payload();
    const fn = vi.fn<Handler>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/inbox")) return Response.json({ count: 0, items: [] });
      if (url === "/api/review" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { step: ReviewStep; value: string };
        if (body.step === "clear") return new Response(null, { status: 500 });
        current = { ...current, answers: { ...current.answers, [body.step]: body.value } };
        return Response.json(current);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fn);

    render(<ReviewPage initial={payload()} />);
    fireEvent.change(screen.getByLabelText("Anything to flag before moving on"), { target: { value: "will fail" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // clear -> back, save fails
    await waitFor(() => expect(screen.getByLabelText("How did the week go")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull(); // the failure belongs to "clear", not shown here
    // But it stays visible from here, in the nav — a person on "back" can see "clear" never stored.
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear the decks, not saved" })).toBeTruthy());

    fireEvent.change(screen.getByLabelText("How did the week go"), { target: { value: "will succeed" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // back -> goals, save succeeds
    await waitFor(() => expect(screen.getByText("No active goals to check in on.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Back" })); // goals -> back
    fireEvent.click(screen.getByRole("button", { name: "Back" })); // back -> clear
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SAVE_ERROR));
  });

  it("saves the open step when the page itself goes away, not only when the step changes", async () => {
    const fn = stubFetch(payload());
    const { unmount } = render(<ReviewPage initial={payload()} />);
    fireEvent.change(screen.getByLabelText("Anything to flag before moving on"), { target: { value: "typed but never left" } });
    unmount();
    await waitFor(() => expect(patchCalls(fn)).toHaveLength(1));
    expect(patchCalls(fn)[0]).toMatchObject({ step: "clear", value: "typed but never left" });
  });

  it("saves the open step on beforeunload, for a hard close or reload the page never unmounts for", async () => {
    const fn = stubFetch(payload());
    render(<ReviewPage initial={payload()} />);
    fireEvent.change(screen.getByLabelText("Anything to flag before moving on"), { target: { value: "closing the tab" } });
    fireEvent(window, new Event("beforeunload"));
    await waitFor(() => expect(patchCalls(fn).length).toBeGreaterThanOrEqual(1));
    expect(patchCalls(fn)[0]).toMatchObject({ step: "clear", value: "closing the tab" });
  });

  it("saves every dirty step when the page goes, not only the one left open", async () => {
    const fn = vi.fn<Handler>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/inbox")) return Response.json({ count: 0, items: [] });
      if (url === "/api/review" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { step: ReviewStep };
        // "clear" always fails — the exact shape of the bug: a step that failed earlier and
        // was left behind must still be retried when the page goes, not only the step that
        // happens to be open at that moment.
        if (body.step === "clear") return new Response(null, { status: 500 });
        return Response.json(payload());
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fn);

    const { unmount } = render(<ReviewPage initial={payload()} />);
    fireEvent.change(screen.getByLabelText("Anything to flag before moving on"), { target: { value: "PRECIOUS PROSE" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // clear -> back; clear's save fails
    await waitFor(() => expect(screen.getByLabelText("How did the week go")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("How did the week go"), { target: { value: "typed but never left" } });
    unmount(); // back is still open and dirty; clear is dirty from the earlier failure

    await waitFor(() => {
      const calls = patchCalls(fn);
      expect(calls.some((c) => c.step === "clear" && c.value === "PRECIOUS PROSE")).toBe(true);
      expect(calls.some((c) => c.step === "back" && c.value === "typed but never left")).toBe(true);
    });
  });

  it("saves every dirty step on beforeunload too", async () => {
    const fn = vi.fn<Handler>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/inbox")) return Response.json({ count: 0, items: [] });
      if (url === "/api/review" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { step: ReviewStep };
        if (body.step === "clear") return new Response(null, { status: 500 });
        return Response.json(payload());
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fn);

    render(<ReviewPage initial={payload()} />);
    fireEvent.change(screen.getByLabelText("Anything to flag before moving on"), { target: { value: "PRECIOUS PROSE" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByLabelText("How did the week go")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("How did the week go"), { target: { value: "closing on back" } });
    fireEvent(window, new Event("beforeunload"));

    await waitFor(() => {
      const calls = patchCalls(fn);
      expect(calls.some((c) => c.step === "clear" && c.value === "PRECIOUS PROSE")).toBe(true);
      expect(calls.some((c) => c.step === "back" && c.value === "closing on back")).toBe(true);
    });
  });

  it("the step-change heading has no aria-live — focus alone is the announcement", () => {
    stubFetch(payload());
    render(<ReviewPage initial={payload()} />);
    const heading = screen.getByText("Clear the decks step");
    expect(heading.hasAttribute("aria-live")).toBe(false);
  });

  it("does not steal focus on first paint, even under StrictMode's double-invoked effect", () => {
    stubFetch(payload());
    render(
      <StrictMode>
        <ReviewPage initial={payload()} />
      </StrictMode>,
    );
    expect(document.activeElement?.tagName).not.toBe("H2");
  });

  it("shows a visible Finish on the last step instead of a disabled Next, and leaves for Home once it saves", async () => {
    const fn = stubFetch(payload({ step: "ahead" }));
    render(<ReviewPage initial={payload({ step: "ahead" })} />);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    fireEvent.change(screen.getByLabelText("The intention for next week"), { target: { value: "Ship the review." } });
    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/"));
    expect(patchCalls(fn).some((c) => c.step === "ahead" && c.value === "Ship the review.")).toBe(true);
  });

  it("makes a carried task's new plan visible, and does not claim success when the carry fails", async () => {
    const withLeftover = payload({ clear: { inbox: 0, leftover: [planTask(41, "Draft the doc")] } });
    const fn = vi.fn<Handler>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/inbox")) return Response.json({ count: 0, items: [] });
      if (url === "/api/plan" && init?.method === "POST") return Response.json({ date: NEXT_WEEK, tasks: [] });
      if (url.startsWith("/api/review?week=")) return Response.json(withLeftover);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fn);
    render(<ReviewPage initial={withLeftover} />);
    fireEvent.click(screen.getByRole("button", { name: "Carry" }));
    await waitFor(() => expect(screen.getByText("On next week's plan")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Carry" })).toBeNull();
  });

  it("leaves a failed carry looking like nothing happened, not like a success", async () => {
    const withLeftover = payload({ clear: { inbox: 0, leftover: [planTask(41, "Draft the doc")] } });
    const fn = vi.fn<Handler>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/inbox")) return Response.json({ count: 0, items: [] });
      if (url === "/api/plan" && init?.method === "POST") return new Response(null, { status: 500 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fn);
    render(<ReviewPage initial={withLeftover} />);
    fireEvent.click(screen.getByRole("button", { name: "Carry" }));
    await waitFor(() => expect(fn.mock.calls.some(([i]) => String(i) === "/api/plan")).toBe(true));
    expect(screen.queryByText("On next week's plan")).toBeNull();
    expect(screen.getByRole("button", { name: "Carry" })).toBeTruthy();
  });

  it("refreshes the inbox count when InboxProcessor reports the inbox changed, without a click anywhere on the page", async () => {
    const stale = payload({ clear: { inbox: 3, leftover: [] } });
    const cleared = payload({ clear: { inbox: 0, leftover: [] } });
    const fn = vi.fn<Handler>(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/inbox")) return Response.json({ count: 0, items: [] });
      if (url.startsWith("/api/review?week=")) return Response.json(cleared);
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fn);
    render(<ReviewPage initial={stale} />);
    const heading = () => screen.getByRole("heading", { level: 2, name: /^Inbox/ });
    expect(heading().textContent).toContain("3");

    fireEvent(window, new Event("sb:inbox-changed"));

    await waitFor(() => expect(fn.mock.calls.some(([i]) => String(i).startsWith("/api/review?week="))).toBe(true));
    await waitFor(() => expect(heading().textContent).not.toContain("3"));
    expect(heading().textContent).toContain("0");
  });
});
