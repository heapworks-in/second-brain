// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { BoxVerdict } from "./box-verdict";
import { resetFocusStore } from "./focus-store";
import type { FocusCompletedDetail } from "./use-focus";
import type { FocusRunDTO, FocusSettingsDTO } from "@/lib/dto";

const TIMEBOX: FocusSettingsDTO = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "timebox" };
const POMODORO: FocusSettingsDTO = { ...TIMEBOX, mode: "pomodoro" };

function run(over: Partial<FocusRunDTO> = {}): FocusRunDTO {
  return {
    id: 1,
    taskId: 9,
    taskTitle: "Finish the Postgres migration",
    blockId: 3,
    startedAt: "2026-09-25T10:00:00.000Z",
    endedAt: "2026-09-25T10:45:00.000Z",
    plannedMinutes: 45,
    actualMinutes: 45,
    outcome: "completed",
    ...over,
  };
}

function complete(over: Partial<FocusCompletedDetail> = {}) {
  const detail: FocusCompletedDetail = { run: run(), completedToday: 1, settings: TIMEBOX, where: [], ...over };
  act(() => {
    window.dispatchEvent(new CustomEvent<FocusCompletedDetail>("sb:focus-completed", { detail }));
  });
}

function stubApi(over: { blocks?: () => Response } = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/blocks") return over.blocks ? over.blocks() : Response.json({ id: 8, taskId: 9, startsAt: "2026-09-25T14:20:00", minutes: 45, spentMinutes: 0 }, { status: 201 });
      return Response.json({});
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.unstubAllGlobals();
});

describe("BoxVerdict", () => {
  it("asks nothing until a box is up, and then says what was promised and on what", async () => {
    stubApi();
    const { container } = render(<BoxVerdict />);
    expect(container.textContent).toBe("");

    complete();
    expect(await screen.findByText("45m on Finish the Postgres migration is up.")).toBeTruthy();
  });

  it("leaves a pomodoro alone — that run ends in a break, not a decision", async () => {
    stubApi();
    render(<BoxVerdict />);
    complete({ settings: POMODORO });
    await waitFor(() => expect(screen.queryByText(/is up\./)).toBeNull());
  });

  it("says nothing about a box on nothing in particular: there is no task to decide about", async () => {
    stubApi();
    render(<BoxVerdict />);
    complete({ run: run({ taskId: null, taskTitle: "" }) });
    await waitFor(() => expect(screen.queryByText(/is up\./)).toBeNull());
  });

  it("Done closes the task", async () => {
    const calls = stubApi();
    render(<BoxVerdict />);
    complete();
    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/tasks/9" && c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.url === "/api/tasks/9")!.body).toEqual({ status: "done" });
    await waitFor(() => expect(screen.queryByText(/is up\./)).toBeNull());
  });

  it("another box books one more of the same length in the day's first free time, and says when", async () => {
    const calls = stubApi();
    const toasts: string[] = [];
    window.addEventListener("sb:toast", (e) => toasts.push((e as CustomEvent<{ text: string }>).detail.text));
    render(<BoxVerdict />);
    complete();
    fireEvent.click(await screen.findByRole("button", { name: "Another 45m" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/blocks")).toBe(true));
    const body = calls.find((c) => c.url === "/api/blocks")!.body as Record<string, unknown>;
    expect(body).toMatchObject({ taskId: 9, minutes: 45, at: "next-free" });
    await waitFor(() => expect(toasts).toContain("Another 45m at 14:20"));
  });

  it("a full day is said in the words the domain used, and the question stays up", async () => {
    const toasts: string[] = [];
    window.addEventListener("sb:toast", (e) => toasts.push((e as CustomEvent<{ text: string }>).detail.text));
    stubApi({ blocks: () => Response.json({ error: "No 45 free minutes left that day" }, { status: 409 }) });
    render(<BoxVerdict />);
    complete();
    fireEvent.click(await screen.findByRole("button", { name: "Another 45m" }));
    await waitFor(() => expect(toasts).toContain("No 45 free minutes left that day"));
    expect(screen.getByText(/is up\./)).toBeTruthy();
  });

  it("leaving it puts the line away and writes nothing", async () => {
    const calls = stubApi();
    render(<BoxVerdict />);
    complete();
    fireEvent.click(await screen.findByRole("button", { name: "Leave it for now" }));
    await waitFor(() => expect(screen.queryByText(/is up\./)).toBeNull());
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("still says where the time went, the same as the break offer does", async () => {
    stubApi();
    render(<BoxVerdict />);
    complete({ where: [{ label: "Code", ms: 40 * 60_000 }] });
    expect(await screen.findByText("45m focused — 40m on Code")).toBeTruthy();
  });
});
