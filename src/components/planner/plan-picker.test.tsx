// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import type { PlannerDayDTO, TaskDTO } from "@/lib/dto";
import { PlanPicker } from "./plan-picker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TODAY = "2026-09-23";
let nextId = 1;
function task(over: Partial<TaskDTO> & { title: string }): TaskDTO {
  return {
    id: nextId++, notes: "", status: "open", priority: "normal", dueDate: null, containerId: null, sourceItemId: null, requester: null, askedOn: null,
    estimateMinutes: null, sessionMinutes: null, blocks: [], goals: [], spentMinutes: 0, likeThisMinutes: null, completedAt: null, sortOrder: 0, createdAt: "2026-09-22T09:00:00.000Z", updatedAt: "2026-09-22T09:00:00.000Z", ...over,
  };
}
const launch = { id: 10, name: "Launch", slug: "launch", kind: "project" as const };
const health = { id: 11, name: "Health", slug: "health", kind: "area" as const };
const loose = task({ title: "Loose one" });
const late = task({ title: "Late one", dueDate: "2026-09-20", containerId: 10 });
const ship = task({ title: "Ship it", containerId: 10, estimateMinutes: 45 });
const walk = task({ title: "Walk", containerId: 11 });
const leftover = task({ title: "Left over" });
const planned = task({ title: "Already planned", containerId: 10 });

function day(over: Partial<PlannerDayDTO> = {}): PlannerDayDTO {
  return {
    date: TODAY,
    plan: [{ ...planned, planId: 1 }],
    unfinishedYesterday: [leftover, planned],
    meetings: [],
    calendar: { calendarsSeen: 1, permission: true },
    sources: { owed: [], inbox: [loose], due: { overdue: [late], today: [] }, projects: [{ container: launch, tasks: [late, ship, planned] }], areas: [{ container: health, tasks: [walk] }] },
    capacity: { freeMinutes: 540, plannedMinutes: 0, unestimated: 0, workHours: "09:00-18:00", workingDays: [1, 2, 3, 4, 5], blockedMinutes: 0, unplacedMinutes: 0, drift: null, forecastMinutes: null, leftTodayMinutes: 540 },
    ...over,
  };
}

function stub() {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/tasks") return Response.json({ id: 99 }, { status: 201 });
      return Response.json({});
    }),
  );
  return posts;
}

const field = () => screen.getByRole("combobox", { name: "Add a task for today" });

describe("PlanPicker", () => {
  it("suggests what is due and what yesterday left, and plans the first on Enter, staying open", async () => {
    const posts = stub();
    const events: string[] = [];
    window.addEventListener("sb:plan-changed", () => events.push("plan"));
    render(<PlanPicker day={day()} today={TODAY} />);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(field());
    const list = screen.getByRole("listbox", { name: "Tasks to plan" });
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Due", "From yesterday"]);
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Late one"), expect.stringContaining("Left over")]));
    expect(within(list).queryByText("Already planned")).toBeNull();
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(posts).toEqual([{ url: "/api/plan", body: { date: TODAY, taskId: late.id } }]));
    expect(events).toEqual(["plan"]);
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(document.activeElement).toBe(field());
  });

  it("leads with what somebody is waiting on, and names a task once though it is also overdue", async () => {
    const posts = stub();
    const owedLate = task({ title: "Owed and late", dueDate: "2026-09-20", requester: { id: 9, name: "Priya Raman", slug: "priya-raman" }, askedOn: "2026-09-16" });
    render(<PlanPicker day={day({ sources: { ...day().sources, owed: [owedLate], due: { overdue: [owedLate, late], today: [] } } })} today={TODAY} />);
    fireEvent.focus(field());
    const list = screen.getByRole("listbox", { name: "Tasks to plan" });
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Owed", "Due", "From yesterday"]);
    expect(within(within(list).getAllByRole("group")[0]).getAllByRole("option")).toHaveLength(1);
    // Offered under Owed, so Due carries only the other overdue task.
    expect(within(within(list).getAllByRole("group")[1]).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Late one")]);
    // Enter takes the first option, which is now the one somebody is waiting on.
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(posts).toEqual([{ url: "/api/plan", body: { date: TODAY, taskId: owedLate.id } }]));
  });

  it("browses the owed chip on its own", () => {
    stub();
    const owed = task({ title: "Unblock the review", requester: { id: 9, name: "Priya Raman", slug: "priya-raman" }, askedOn: "2026-09-16" });
    render(<PlanPicker day={day({ sources: { ...day().sources, owed: [owed] } })} today={TODAY} />);
    fireEvent.focus(field());
    fireEvent.click(screen.getByRole("button", { name: "Owed" }));
    expect(within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Unblock the review")]);
  });

  it("searches every home as you type, groups by home, and plans the arrowed row", async () => {
    const posts = stub();
    render(<PlanPicker day={day()} today={TODAY} />);
    fireEvent.change(field(), { target: { value: "o" } });
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Inbox", "Launch", "New"]);
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(field().getAttribute("aria-activedescendant")).toContain(`task-${late.id}`);
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(posts).toEqual([{ url: "/api/plan", body: { date: TODAY, taskId: late.id } }]));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((field() as HTMLInputElement).value).toBe("");
  });

  it("creates what nothing matches, reading the estimate and the due word, then plans it", async () => {
    const posts = stub();
    render(<PlanPicker day={day()} today={TODAY} />);
    fireEvent.change(field(), { target: { value: "Call the bank ~15m" } });
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    expect(within(list).getByRole("option").textContent).toContain("Create");
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(["/api/tasks", "/api/plan"]));
    expect(posts[0].body).toMatchObject({ title: "Call the bank", estimateMinutes: 15 });
    expect(posts[0].body).not.toHaveProperty("containerId");
    expect(posts[1].body).toEqual({ date: TODAY, taskId: 99 });
  });

  it("creates a task with a session length from ~2h/45m", async () => {
    const posts = stub();
    render(<PlanPicker day={day()} today={TODAY} />);
    fireEvent.change(field(), { target: { value: "Deep work ~2h/45m" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(["/api/tasks", "/api/plan"]));
    expect(posts[0].body).toMatchObject({ title: "Deep work", estimateMinutes: 120, sessionMinutes: 45 });
  });

  it("browses one home from the chips, closes on Escape and on a click away", () => {
    stub();
    render(
      <div>
        <button type="button">Elsewhere</button>
        <PlanPicker day={day()} today={TODAY} />
      </div>,
    );
    fireEvent.focus(field());
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    const list = screen.getByRole("listbox");
    expect(within(list).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Launch"]);
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Late one"), expect.stringContaining("Ship it")]);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(field());
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on projects with the keyboard when the ritual asks", () => {
    stub();
    render(<PlanPicker day={day()} today={TODAY} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("sb:plan-picker", { detail: { filter: "projects", focus: true } }));
    });
    expect(document.activeElement).toBe(field());
    expect(screen.getByRole("button", { name: "Projects" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("listbox")).getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual(["Launch"]);
  });

  it("says so when there is nothing to suggest", () => {
    stub();
    render(<PlanPicker day={day({ unfinishedYesterday: [], sources: { owed: [], inbox: [], due: { overdue: [], today: [] }, projects: [], areas: [] } })} today={TODAY} />);
    fireEvent.focus(field());
    expect(screen.getByText(/Nothing due and nothing left from yesterday/)).toBeTruthy();
  });

  it("names the field after another day, and offers a task once though it is due and left over", () => {
    stub();
    const both = task({ title: "Both lists", dueDate: "2026-09-20" });
    const d = day({ date: "2026-09-24", unfinishedYesterday: [both], sources: { ...day().sources, due: { overdue: [both], today: [] } } });
    render(<PlanPicker day={d} today={TODAY} />);
    const input = screen.getByRole("combobox", { name: "Add a task for Thu 24" });
    fireEvent.focus(input);
    expect(within(screen.getByRole("listbox")).getAllByText("Both lists")).toHaveLength(1);
  });

  it("keeps the keyboard in the field when an option is clicked, wraps the arrows, and skips a title-less create", () => {
    stub();
    render(<PlanPicker day={day()} today={TODAY} />);
    field().focus();
    fireEvent.focus(field());
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    fireEvent.mouseDown(options[0]);
    expect(document.activeElement).toBe(field());
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(field().getAttribute("aria-activedescendant")).toContain(options[options.length - 1].id.split("-").slice(-2).join("-"));
    fireEvent.change(field(), { target: { value: "~15m" } });
    expect(within(screen.getByRole("listbox")).queryByText(/Create/)).toBeNull();
  });
});
