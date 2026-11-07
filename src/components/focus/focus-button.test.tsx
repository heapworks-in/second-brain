// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { FocusButton } from "./focus-button";
import { resetFocusStore } from "./focus-store";
import type { FocusRunDTO, FocusSettingsDTO } from "@/lib/dto";

const SETTINGS: FocusSettingsDTO = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" };
const STARTED_AT = "2026-09-25T10:00:00.000Z";

function run(over: Partial<FocusRunDTO> = {}): FocusRunDTO {
  return {
    id: 1,
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

/** Answers the focus poll with `live`, and records every write `FocusButton` makes. */
function stubFocus(live: FocusRunDTO | null) {
  const writes: { url: string; method?: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/focus" && !init?.method) return Response.json({ run: live, settings: SETTINGS, completedToday: 0 });
      writes.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/focus" && init?.method === "POST") return Response.json(run({ id: 2 }), { status: 201 });
      if (url.startsWith("/api/focus/") && init?.method === "PATCH") return Response.json({ run: { ...(live ?? run()), outcome: "stopped" }, where: [] });
      return new Response("{}", { status: 404 });
    }),
  );
  return writes;
}

beforeEach(() => {
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TASK = { id: 9, title: "Draft the brief" };

describe("FocusButton — live match", () => {
  it("the plain button reads Stop for its task whatever the run's blockId is", async () => {
    stubFocus(run({ taskId: TASK.id, blockId: 77 }));
    render(<FocusButton task={TASK} />);
    expect(await screen.findByRole("button", { name: "Stop focusing on Draft the brief" })).toBeTruthy();
  });

  it("the plain button reads Focus for a different task", async () => {
    stubFocus(run({ taskId: 999 }));
    render(<FocusButton task={TASK} />);
    expect(await screen.findByRole("button", { name: "Focus on Draft the brief" })).toBeTruthy();
  });

  it("a block-scoped button reads Stop only when its own blockId is the one running", async () => {
    stubFocus(run({ taskId: TASK.id, blockId: 5 }));
    render(<FocusButton task={TASK} blockId={5} compact />);
    expect(await screen.findByRole("button", { name: "Stop focusing on Draft the brief" })).toBeTruthy();
  });

  it("a block-scoped button reads Focus when a different session of the same task is running", async () => {
    stubFocus(run({ taskId: TASK.id, blockId: 5 }));
    render(<FocusButton task={TASK} blockId={6} compact />);
    expect(await screen.findByRole("button", { name: "Focus on Draft the brief" })).toBeTruthy();
  });
});

describe("FocusButton — what begin() sends", () => {
  it("a plain row posts only taskId, so the saved default applies", async () => {
    const writes = stubFocus(null);
    render(<FocusButton task={TASK} />);
    fireEvent.click(await screen.findByRole("button", { name: "Focus on Draft the brief" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ url: "/api/focus", method: "POST", body: { taskId: 9 } });
    expect(writes[0].body).not.toHaveProperty("minutes");
  });

  it("a session on the timeline posts taskId and blockId, never a recomputed minutes", async () => {
    const writes = stubFocus(null);
    render(<FocusButton task={TASK} blockId={42} compact />);
    fireEvent.click(await screen.findByRole("button", { name: "Focus on Draft the brief" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ url: "/api/focus", method: "POST", body: { taskId: 9, blockId: 42 } });
    expect(writes[0].body).not.toHaveProperty("minutes");
  });

  it("a menu preset posts the explicit minutes it names", async () => {
    const writes = stubFocus(null);
    render(<FocusButton task={TASK} menu />);
    fireEvent.click(await screen.findByRole("button", { name: "Other lengths" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "25 minutes" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ url: "/api/focus", method: "POST", body: { taskId: 9, minutes: 25 } });
  });
});

describe("FocusButton — the menu", () => {
  it("Escape closes it and returns focus to the caret", async () => {
    stubFocus(null);
    render(<FocusButton task={TASK} menu />);
    const caret = await screen.findByRole("button", { name: "Other lengths" });
    fireEvent.click(caret);
    expect(screen.getByRole("menu", { name: "Focus for" })).toBeTruthy();
    expect(caret.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "Focus for" })).toBeNull();
    expect(caret.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(caret);
  });

  it("a mousedown outside closes it, but one inside the panel does not", async () => {
    stubFocus(null);
    render(<FocusButton task={TASK} menu />);
    fireEvent.click(await screen.findByRole("button", { name: "Other lengths" }));

    fireEvent.mouseDown(screen.getByRole("menuitem", { name: "25 minutes" }));
    expect(screen.getByRole("menu", { name: "Focus for" })).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "Focus for" })).toBeNull();
  });

  it("removes its window listeners once closed", async () => {
    stubFocus(null);
    render(<FocusButton task={TASK} menu />);
    const caret = await screen.findByRole("button", { name: "Other lengths" });
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    fireEvent.click(caret);
    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});

describe("FocusButton — icon-only labels", () => {
  // The compact shape is icon-only: the aria-label is the only thing a screen reader gets.
  it("labels the compact idle button", async () => {
    stubFocus(null);
    render(<FocusButton task={TASK} compact />);
    const button = await screen.findByRole("button", { name: "Focus on Draft the brief" });
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.textContent).toBe("");
  });

  it("labels the compact live button", async () => {
    stubFocus(run({ taskId: TASK.id }));
    render(<FocusButton task={TASK} compact />);
    const button = await screen.findByRole("button", { name: "Stop focusing on Draft the brief" });
    expect(button.querySelector("svg")).toBeTruthy();
    expect(button.textContent).toBe("");
  });
});
