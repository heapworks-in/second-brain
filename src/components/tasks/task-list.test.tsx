// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup , waitFor } from "@testing-library/react";
import { TaskList } from "./task-list";
import { resetFocusStore } from "../focus/focus-store";
import type { TaskDTO } from "@/lib/dto";

// See container-editor.test.tsx: this vitest config has no global `afterEach`, so
// @testing-library/react's auto-cleanup never registers and DOM from one `it` would
// otherwise still be attached (and matched by role/name queries) in the next.
beforeEach(() => {
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.unstubAllGlobals();
});

const base: TaskDTO = {
  id: 1, title: "Draft email", notes: "", status: "open", priority: "normal", dueDate: null, containerId: 5, sourceItemId: null, requester: null, askedOn: null,
  estimateMinutes: null, sessionMinutes: null, blocks: [], goals: [], spentMinutes: 0, likeThisMinutes: null, completedAt: null, sortOrder: 0, createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
};
const progress = { open: 1, done: 0, total: 1, percent: 0, nextTask: { id: 1, title: "Draft email", dueDate: null } };

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(handler));
}

describe("TaskList", () => {
  it("adds a task on Enter using quick-parse and keeps focus", async () => {
    const calls: unknown[] = [];
    stub(async (url, init) => {
      if (init?.method === "POST" && url === "/api/tasks") {
        calls.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ...base, id: 2, title: "Ship it", priority: "high", dueDate: "2026-09-18" }), { status: 201 });
      }
      return new Response(JSON.stringify({ tasks: [base], progress }), { status: 200 });
    });
    render(<TaskList containerId={5} initialTasks={[base]} today="2026-09-16" />);
    const input = screen.getByPlaceholderText("Add a task") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "! Ship it ~45m fri" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(calls[0]).toMatchObject({ title: "Ship it", priority: "high", containerId: 5, estimateMinutes: 45 });
    expect((calls[0] as { dueDate: string }).dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(await screen.findByText("Ship it")).toBeTruthy();
  });

  it("adds a task with a session length from ~2h/45m", async () => {
    const calls: unknown[] = [];
    stub(async (url, init) => {
      if (init?.method === "POST" && url === "/api/tasks") {
        calls.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ...base, id: 2, title: "Deep work", estimateMinutes: 120, sessionMinutes: 45 }), { status: 201 });
      }
      return new Response(JSON.stringify({ tasks: [base], progress }), { status: 200 });
    });
    render(<TaskList containerId={5} initialTasks={[base]} today="2026-09-16" />);
    const input = screen.getByPlaceholderText("Add a task") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "Deep work ~2h/45m" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(calls[0]).toMatchObject({ title: "Deep work", estimateMinutes: 120, sessionMinutes: 45 });
  });

  it("refetches the list and the progress when a task changes elsewhere", async () => {
    const added: TaskDTO = { ...base, id: 3, title: "Booked from the prompt bar", sortOrder: 1 };
    const refreshed = { open: 2, done: 0, total: 2, percent: 0, nextTask: { id: 1, title: "Draft email", dueDate: null } };
    const urls: string[] = [];
    stub(async (url) => {
      // The store makes exactly one `/api/focus` call for the whole page, not one per row, but
      // it is still background noise unrelated to what this list refetches when a task changes
      // elsewhere. The plan read on mount is the same kind of noise: what this case is about is
      // that one tasks-changed event causes exactly one task refetch.
      if (url !== "/api/focus" && !url.startsWith("/api/plan")) urls.push(url);
      return new Response(JSON.stringify({ tasks: [base, added], progress: refreshed }), { status: 200 });
    });
    const onProgress = vi.fn();
    render(<TaskList containerId={5} initialTasks={[base]} onProgress={onProgress} today="2026-09-16" />);
    expect(screen.queryByText("Booked from the prompt bar")).toBeNull();

    await act(async () => { window.dispatchEvent(new Event("sb:tasks-changed")); });

    expect(urls).toEqual(["/api/tasks?container=5&status=all"]);
    expect(await screen.findByText("Booked from the prompt bar")).toBeTruthy();
    expect(onProgress).toHaveBeenCalledWith(refreshed);
  });

  it("stops listening for task changes once it unmounts", async () => {
    const urls: string[] = [];
    stub(async (url) => {
      if (url !== "/api/focus" && !url.startsWith("/api/plan")) urls.push(url);
      return new Response(JSON.stringify({ tasks: [base], progress }), { status: 200 });
    });
    const { unmount } = render(<TaskList containerId={5} initialTasks={[base]} today="2026-09-16" />);
    unmount();
    await act(async () => { window.dispatchEvent(new Event("sb:tasks-changed")); });
    expect(urls).toEqual([]);
  });

  it("marks done with one PATCH and reverts on failure", async () => {
    const patches: unknown[] = [];
    let fail = false;
    stub(async (url, init) => {
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        if (fail) return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
        return new Response(JSON.stringify({ ...base, status: "done", completedAt: "2026-09-16T01:00:00.000Z" }), { status: 200 });
      }
      return new Response(JSON.stringify({ tasks: [base], progress }), { status: 200 });
    });
    render(<TaskList containerId={5} initialTasks={[base]} today="2026-09-16" />);
    const box = screen.getByRole("checkbox", { name: "Draft email" }) as HTMLInputElement;
    await act(async () => { fireEvent.click(box); });
    expect(patches).toEqual([{ status: "done" }]);
    expect(screen.getByRole("button", { name: /1 done/ })).toBeTruthy();
    fail = true;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /1 done/ })); });
    const reopen = await screen.findByRole("button", { name: "Reopen" });
    await act(async () => { fireEvent.click(reopen); });
    expect(await screen.findByText("Could not save that change")).toBeTruthy();
    expect(screen.getByRole("button", { name: /1 done/ })).toBeTruthy();
  });
});

/**
 * Planning from a task list that does not itself show the plan. It used to be one-way and silent:
 * the row could not say whether the task was already planned, so it could never offer to take it
 * off, and the only feedback was a toast on the keyboard path that the menu did not share.
 */
describe("planning from the list", () => {
  function stubWithPlan(plannedIds: number[]) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    stub(async (url, init) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.startsWith("/api/plan") && method === "GET") {
        return new Response(JSON.stringify({ tasks: plannedIds.map((id) => ({ id })) }), { status: 200 });
      }
      return new Response(JSON.stringify({ tasks: [base], progress }), { status: 200 });
    });
    return calls;
  }

  async function openMenu() {
    fireEvent.click(await screen.findByRole("button", { name: "Task actions" }));
  }

  it("offers to take a planned task off the plan, not to plan it again", async () => {
    stubWithPlan([base.id]);
    render(<TaskList containerId={5} initialTasks={[base]} today="2026-09-16" />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Task actions" })).toBeTruthy());
    await openMenu();
    expect(await screen.findByRole("menuitem", { name: "Remove from plan" })).toBeTruthy();
  });

  it("takes it off through the plan route when asked", async () => {
    const calls = stubWithPlan([base.id]);
    render(<TaskList containerId={5} initialTasks={[base]} today="2026-09-16" />);
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/plan"))).toBe(true));
    await openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from plan" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/plan" && c.method === "DELETE")).toBe(true));
    // The day this list was rendered for, not whatever day the test machine is on: that is the
    // whole reason `today` is a prop here.
    expect(calls.find((c) => c.method === "DELETE")!.body).toEqual({ date: "2026-09-16", taskId: base.id });
  });

  it("stops listening for plan changes once it unmounts", async () => {
    const calls = stubWithPlan([]);
    const { unmount } = render(<TaskList containerId={5} initialTasks={[base]} today="2026-09-16" />);
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/plan"))).toBe(true));
    const before = calls.length;
    unmount();
    await act(async () => {
      window.dispatchEvent(new Event("sb:plan-changed"));
    });
    expect(calls.length).toBe(before);
  });
});
