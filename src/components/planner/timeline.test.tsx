// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { Timeline, type BlockAction, type BlockResult } from "./timeline";
import type { MeetingListDTO, PlanTaskDTO } from "@/lib/dto";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push, refresh: () => {} }), usePathname: () => "/planner" }));

const DATE = "2026-09-22";

const sync: MeetingListDTO = {
  id: 3,
  title: "Product sync",
  startsAt: `${DATE}T10:00:00`,
  endsAt: `${DATE}T11:00:00`,
  attendees: 3,
  hasCallLink: true,
  interview: false,
  scheduledMs: 3_600_000,
  actualMs: 0,
  itemId: 7,
  organizer: "Ada Lovelace",
  attendeeNames: [],
  location: "",
  joinUrl: "https://meet.example.com/sync",
  allDay: false,
  status: "accepted",
  calendarTitle: "Work",
  noRecord: false,
  seriesId: null,
  decision: "going",
  decisionNote: "",
  seriesDecision: null,
    containerId: null,
    containerFromSeries: false,
  item: { id: 7, hasNotes: true, hasTranscript: false, hasSummary: true, containerId: null },
};

const blocked: PlanTaskDTO = {
  id: 12,
  title: "Write the note",
  notes: "",
  status: "open",
  priority: "normal",
  dueDate: null,
  containerId: null,
  sourceItemId: null,
  estimateMinutes: 45,
  sessionMinutes: null,
  blocks: [{ id: 1, taskId: 12, startsAt: `${DATE}T10:30:00`, minutes: 45, spentMinutes: 0 }],
  goals: [],
  spentMinutes: 0,
  likeThisMinutes: null,
  completedAt: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
  planId: 1,
};

/** The same task, its 90 minutes split into two sessions on the day. */
const twoSessions: PlanTaskDTO = {
  ...blocked,
  estimateMinutes: 90,
  blocks: [
    { id: 1, taskId: 12, startsAt: `${DATE}T10:30:00`, minutes: 45, spentMinutes: 0 },
    { id: 2, taskId: 12, startsAt: `${DATE}T14:00:00`, minutes: 45, spentMinutes: 0 },
  ],
};

/** The id the day gives a session the column just placed. */
const NEW_BLOCK = 91;

/** Every PATCH the timeline asked for, in order; nothing here reaches the network. */
function stubPatch(): { id: number; body: unknown }[] {
  const posts: { id: number; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") posts.push({ id: Number(String(input).split("/").pop()), body: JSON.parse(String(init.body)) });
      // The blocks beside the meetings still ask what the recorder can do.
      if (String(input) === "/api/meetings/recorder") return Response.json({ state: "idle", missing: [] });
      return Response.json({});
    }),
  );
  return posts;
}

/** What DayView hands the timeline: a PATCH that answers whether it went through. */
async function patchTask(id: number, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.ok;
}

/** Every session action the timeline asked for, answered the way the block routes answer. */
function stubBlocks(): { acts: BlockAction[]; onBlock: (action: BlockAction) => BlockResult } {
  const acts: BlockAction[] = [];
  return {
    acts,
    onBlock: async (action) => {
      acts.push(action);
      return action.kind === "add" ? NEW_BLOCK : action.id;
    },
  };
}

/** For the cases that never touch a session: the writes go through, unrecorded. */
const onBlock = async (action: BlockAction): BlockResult => (action.kind === "add" ? NEW_BLOCK : action.id);

// jsdom has neither DragEvent nor PointerEvent, so testing-library builds both from plain
// Event and the coordinates fall off them. A MouseEvent in their place carries clientY, which
// is the only thing the column and the resize handle measure by.
beforeAll(() => {
  const w = window as unknown as Record<string, unknown>;
  if (!w.DragEvent) w.DragEvent = window.MouseEvent;
  if (!w.PointerEvent) w.PointerEvent = window.MouseEvent;
});

/** The strip along a block's bottom edge; it is out of the accessibility tree by design. */
const resizeHandle = (block: HTMLElement) => block.querySelector<HTMLElement>("[data-resize]")!;

/** The now line: the one violet rule on the column, as against the blocks' violet left edge. */
const nowLine = (root: HTMLElement) => root.querySelector(".border-t.border-violet");

/** The column, told where it sits, since jsdom lays nothing out. */
function column(top = 100): HTMLElement {
  const el = screen.getByTestId("timeline-column");
  Object.defineProperty(el, "getBoundingClientRect", { value: () => ({ top, left: 0, width: 400, height: 540 }) });
  return el;
}

afterEach(() => {
  cleanup();
  nav.push.mockClear();
  vi.unstubAllGlobals();
});

describe("Timeline", () => {
  it("says what a box actually cost once something has run against it, and warns when it ran over", () => {
    const ran = { ...blocked, blocks: [{ ...blocked.blocks[0], spentMinutes: 30 }] };
    const { rerender } = render(<Timeline date={DATE} meetings={[]} tasks={[ran]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    expect(screen.getByText(/ran 30m/).className).not.toContain("text-warn");
    // The figure the whole box exists to make honest: 45 promised, 52 spent.
    const over = { ...blocked, blocks: [{ ...blocked.blocks[0], spentMinutes: 52 }] };
    rerender(<Timeline date={DATE} meetings={[]} tasks={[over]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    expect(screen.getByText(/ran 52m/).className).toContain("text-warn");
    // Part of what the block says, not only a colour.
    expect(screen.getByRole("group", { name: /ran 52m/ })).toBeTruthy();
  });

  it("says nothing about cost before anything has run against the box", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[blocked]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    expect(screen.queryByText(/ran /)).toBeNull();
  });

  it("names a block by its title, its hours, and how many are coming", () => {
    render(<Timeline date={DATE} meetings={[sync]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    expect(screen.getByRole("button", { name: "Product sync, 10:00 to 11:00, 3 attendees" })).toBeTruthy();
  });

  it("opens the call in a new tab beside the block", () => {
    render(<Timeline date={DATE} meetings={[sync]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    const join = screen.getByRole("link", { name: "Join Product sync" });
    expect(join.getAttribute("href")).toBe("https://meet.example.com/sync");
    expect(join.getAttribute("target")).toBe("_blank");
    expect(join.getAttribute("rel")).toContain("noreferrer");
  });

  it("dots the block with what its note already holds", () => {
    render(<Timeline date={DATE} meetings={[sync]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    expect(screen.getByTitle("Notes")).toBeTruthy();
    expect(screen.getByTitle("Summary")).toBeTruthy();
    expect(screen.queryByTitle("Transcript")).toBeNull();
  });

  // A meeting under 48 minutes drops the attendee/Join row entirely (`b.height >= 48`) -- Record
  // must not have gone with it, since it's the one control someone actually presses from here.
  it("keeps Record on a meeting too short for the attendee/Join row", () => {
    const short: MeetingListDTO = { ...sync, id: 4, title: "Quick standup", startsAt: `${DATE}T10:00:00`, endsAt: `${DATE}T10:20:00` };
    render(<Timeline date={DATE} meetings={[short]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    expect(screen.getByRole("button", { name: "Record Quick standup" })).toBeTruthy();
    // The row it used to share a fate with is still gone, on a meeting this short.
    expect(screen.queryByRole("link", { name: /Join/ })).toBeNull();
  });

  // Under 30 minutes the time-range row has nowhere to sit without the block's own
  // overflow-hidden clipping it, so a compact length rides the title row instead of vanishing.
  it("shows a compact length instead of the time-range row on a meeting too short for it", () => {
    const short: MeetingListDTO = { ...sync, id: 4, title: "Quick standup", startsAt: `${DATE}T10:00:00`, endsAt: `${DATE}T10:20:00` };
    render(<Timeline date={DATE} meetings={[short]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    expect(screen.getByText("20m")).toBeTruthy();
    expect(screen.queryByText("10:00–10:20")).toBeNull();
  });

  it("draws no current-time line on a day that is not today", () => {
    const { container } = render(
      <Timeline
        date="2019-01-07"
        meetings={[{ ...sync, startsAt: "2019-01-07T10:00:00", endsAt: "2019-01-07T11:00:00" }]}
        tasks={[]}
        onPatchTask={patchTask}
        onBlock={onBlock}
      />,
    );
    expect(nowLine(container)).toBeNull();
  });

  it("covers the working hours, widened only to hold a meeting outside them", () => {
    const { container, unmount } = render(<Timeline date={DATE} meetings={[]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const labels = () => Array.from(container.querySelectorAll("span.font-mono")).map((el) => el.textContent).filter((t) => /^\d\d:00$/.test(t ?? ""));
    expect(labels()[0]).toBe("09:00");
    expect(labels().at(-1)).toBe("18:00");
    unmount();
    const early = { ...sync, startsAt: `${DATE}T07:30:00`, endsAt: `${DATE}T08:00:00` };
    const { container: c2 } = render(<Timeline date={DATE} meetings={[early]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const first = Array.from(c2.querySelectorAll("span.font-mono")).map((el) => el.textContent).find((t) => /^\d\d:00$/.test(t ?? ""));
    expect(first).toBe("07:00");
  });

  it("excludes a not-going meeting from the timed column and from widening the hour range", () => {
    const declined = { ...sync, id: 4, decision: "not-going" as const, startsAt: `${DATE}T07:00:00`, endsAt: `${DATE}T07:30:00` };
    const { container } = render(
      <Timeline date={DATE} meetings={[declined]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />,
    );
    expect(screen.queryByRole("button", { name: /Product sync/ })).toBeNull();
    const labels = () => Array.from(container.querySelectorAll("span.font-mono")).map((el) => el.textContent).filter((t) => /^\d\d:00$/.test(t ?? ""));
    // Had the declined meeting still counted, the range would have widened to 07:00.
    expect(labels()[0]).toBe("09:00");
  });

  it("still draws a maybe meeting: it holds a claim on the time, just not a full one", () => {
    const maybe = { ...sync, decision: "maybe" as const };
    render(<Timeline date={DATE} meetings={[maybe]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    expect(screen.getByRole("button", { name: "Product sync, 10:00 to 11:00, 3 attendees" })).toBeTruthy();
  });

  it("draws a lone session as a block at its start, its own length tall, with no mark", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[blocked]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const block = screen.getByRole("group", { name: "Write the note, 10:30 to 11:15" });
    expect(block.style.top).toBe("90px");
    expect(block.style.height).toBe("45px");
  });

  // A session under 30 minutes drops its time-range line (the same shape the meeting block
  // uses) -- Focus must not have gone with it, since it lived in that same row before this fix
  // and was the one control someone actually presses from here. Its length rides the title row
  // instead of vanishing along with the row it used to share.
  it("keeps Focus on a session too short for its own time-range line", () => {
    const quick: PlanTaskDTO = { ...blocked, id: 13, title: "Quick check", blocks: [{ id: 3, taskId: 13, startsAt: `${DATE}T10:30:00`, minutes: 15, spentMinutes: 0 }] };
    render(<Timeline date={DATE} meetings={[]} tasks={[quick]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    expect(screen.getByRole("button", { name: "Focus on Quick check" })).toBeTruthy();
    expect(screen.queryByText(/10:30.*10:45/)).toBeNull();
    expect(screen.getByText("15m")).toBeTruthy();
  });

  it("draws every session a task holds on the day, each marked with its place", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[twoSessions]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const first = screen.getByRole("group", { name: "Write the note · 1 of 2, 10:30 to 11:15" });
    const second = screen.getByRole("group", { name: "Write the note · 2 of 2, 14:00 to 14:45" });
    expect(first.style.top).toBe("90px");
    expect(second.style.top).toBe("300px");
    expect(within(second).getByText("2 of 2")).toBeTruthy();
  });

  it("leaves another day's sessions off the column", () => {
    const elsewhere = { ...blocked, blocks: [...blocked.blocks, { id: 9, taskId: blocked.id, startsAt: "2026-09-23T09:00:00", minutes: 30, spentMinutes: 0 }] };
    render(<Timeline date={DATE} meetings={[]} tasks={[elsewhere]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Write the note, 10:30 to 11:15" })).toBeTruthy();
  });

  it("drops a plan row onto the timeline at the snapped slot, the ghost as long as the session", async () => {
    const { acts, onBlock: record } = stubBlocks();
    render(<Timeline date={DATE} meetings={[]} tasks={[]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
    const col = column();
    // Through a dragover the data store is protected: only the types can be read, so the row's
    // 45 minutes ride in a type of their own and `getData` answers "" for everything.
    const dt = {
      types: ["application/x-sb-plan", "application/x-sb-plan-minutes-45"],
      getData: (type: string) => (type === "application/x-sb-plan" ? "7" : ""),
      dropEffect: "move",
    };
    fireEvent.dragOver(col, { dataTransfer: { ...dt, getData: () => "" }, clientY: 100 + 93 });
    const ghost = screen.getByTestId("block-ghost");
    expect(ghost.textContent).toBe("10:35");
    expect(ghost.style.top).toBe("95px");
    expect(ghost.style.height).toBe("45px");
    fireEvent.drop(col, { dataTransfer: dt, clientY: 100 + 93 });
    await waitFor(() => expect(acts).toEqual([{ kind: "add", taskId: 7, startsAt: `${DATE}T10:35:00`, minutes: 45 }]));
  });

  it("falls back to the default length for a drag that declares none", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    fireEvent.dragOver(column(), { dataTransfer: { types: ["application/x-sb-plan"], getData: () => "" }, clientY: 100 + 93 });
    expect(screen.getByTestId("block-ghost").style.height).toBe("25px");
  });

  it("keeps a drop on the column's last pixel on the day it was made", async () => {
    const { acts, onBlock: record } = stubBlocks();
    // A session crossing midnight runs the column to 24:00, so its last minute is the day's last.
    const late = { ...blocked, estimateMinutes: null, blocks: [{ id: 1, taskId: blocked.id, startsAt: `${DATE}T23:50:00`, minutes: 25, spentMinutes: 0 }] };
    render(<Timeline date={DATE} meetings={[]} tasks={[late]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
    const col = screen.getByTestId("timeline-column");
    Object.defineProperty(col, "getBoundingClientRect", { value: () => ({ top: 0, left: 0, width: 400, height: 900 }) });
    const dt = { types: ["application/x-sb-plan"], getData: () => "7", dropEffect: "move" };
    fireEvent.drop(col, { dataTransfer: dt, clientY: 900 });
    await waitFor(() => expect(acts).toEqual([{ kind: "add", taskId: 7, startsAt: `${DATE}T23:55:00`, minutes: 25 }]));
  });

  it("moves one session with the arrows, resizes it with alt, and takes it off with backspace", async () => {
    const { acts, onBlock: record } = stubBlocks();
    render(<Timeline date={DATE} meetings={[]} tasks={[twoSessions]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
    const block = screen.getByRole("group", { name: "Write the note · 1 of 2, 10:30 to 11:15" });
    block.focus();
    fireEvent.keyDown(block, { key: "ArrowDown" });
    await waitFor(() => expect(acts.at(-1)).toEqual({ kind: "move", id: 1, startsAt: `${DATE}T10:45:00` }));
    // The day has not come back with 10:45 yet, so the next press counts from it, not from 10:30.
    fireEvent.keyDown(block, { key: "ArrowUp", shiftKey: true });
    await waitFor(() => expect(acts.at(-1)).toEqual({ kind: "move", id: 1, startsAt: `${DATE}T10:40:00` }));
    fireEvent.keyDown(block, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(acts.at(-1)).toEqual({ kind: "resize", id: 1, minutes: 50 }));
    fireEvent.keyDown(block, { key: "Backspace" });
    await waitFor(() => expect(acts.at(-1)).toEqual({ kind: "remove", id: 1 }));
    // Only that session was asked about; the afternoon one is still on the column.
    expect(screen.getByRole("group", { name: "Write the note · 2 of 2, 14:00 to 14:45" })).toBeTruthy();
  });

  describe("the keyboard after a session goes", () => {
    /** Presses backspace on one session and hands back the day that came of it. */
    async function removeAndReload(tasks: PlanTaskDTO[], name: string, after: PlanTaskDTO[]) {
      const { acts, onBlock: record } = stubBlocks();
      const view = render(<Timeline date={DATE} meetings={[]} tasks={tasks} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
      const block = screen.getByRole("group", { name });
      block.focus();
      fireEvent.keyDown(block, { key: "Backspace" });
      await waitFor(() => expect(acts).toHaveLength(1));
      view.rerender(<Timeline date={DATE} meetings={[]} tasks={after} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
    }

    it("moves to the next session on the column", async () => {
      await removeAndReload([twoSessions], "Write the note · 1 of 2, 10:30 to 11:15", [{ ...twoSessions, blocks: [twoSessions.blocks[1]] }]);
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "Write the note, 14:00 to 14:45" }));
    });

    it("falls back to the session before it when there is none after", async () => {
      await removeAndReload([twoSessions], "Write the note · 2 of 2, 14:00 to 14:45", [{ ...twoSessions, blocks: [twoSessions.blocks[0]] }]);
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "Write the note, 10:30 to 11:15" }));
    });

    it("falls back to the column's heading when the last one goes", async () => {
      await removeAndReload([blocked], "Write the note, 10:30 to 11:15", [{ ...blocked, blocks: [] }]);
      expect(document.activeElement?.textContent).toBe("Timeline");
    });

    it("follows the focused session to the fresh ones a place laid in its stead", () => {
      const { rerender } = render(<Timeline date={DATE} meetings={[]} tasks={[twoSessions]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
      screen.getByRole("group", { name: "Write the note · 1 of 2, 10:30 to 11:15" }).focus();
      // A place from the plan pane: the sessions are written again, with ids of their own.
      const replaced = { ...twoSessions, blocks: [{ id: 31, taskId: 12, startsAt: `${DATE}T09:00:00`, minutes: 45, spentMinutes: 0 }, { id: 32, taskId: 12, startsAt: `${DATE}T09:55:00`, minutes: 45, spentMinutes: 0 }] };
      rerender(<Timeline date={DATE} meetings={[]} tasks={[replaced]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
      expect(document.activeElement).toBe(screen.getByRole("group", { name: "Write the note · 1 of 2, 09:00 to 09:45" }));
    });

    it("leaves the keyboard where the person put it", () => {
      const { rerender } = render(<Timeline date={DATE} meetings={[sync]} tasks={[twoSessions]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
      screen.getByRole("group", { name: "Write the note · 1 of 2, 10:30 to 11:15" }).focus();
      const elsewhere = screen.getByRole("button", { name: "Product sync, 10:00 to 11:00, 3 attendees" });
      elsewhere.focus();
      rerender(<Timeline date={DATE} meetings={[sync]} tasks={[{ ...twoSessions, blocks: [] }]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
      expect(document.activeElement).toBe(elsewhere);
    });
  });

  it("names each session's checkbox by the session, not only by the task", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[twoSessions]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    // One name each: two checkboxes called "Done: Write the note" would be the same offer twice.
    expect(screen.getByRole("checkbox", { name: "Done: Write the note · 1 of 2" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Done: Write the note · 2 of 2" })).toBeTruthy();
  });

  it("moves twice before the day comes back, the second press counting from the first", async () => {
    const { acts, onBlock: record } = stubBlocks();
    render(<Timeline date={DATE} meetings={[]} tasks={[blocked]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
    const block = screen.getByRole("group", { name: "Write the note, 10:30 to 11:15" });
    block.focus();
    fireEvent.keyDown(block, { key: "ArrowDown" });
    fireEvent.keyDown(block, { key: "ArrowDown" });
    await waitFor(() =>
      expect(acts).toEqual([
        { kind: "move", id: 1, startsAt: `${DATE}T10:45:00` },
        { kind: "move", id: 1, startsAt: `${DATE}T11:00:00` },
      ]),
    );
  });

  it("counts from the prop again once the day has caught up with the last write", async () => {
    const { acts, onBlock: record } = stubBlocks();
    const { rerender } = render(<Timeline date={DATE} meetings={[]} tasks={[blocked]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
    const block = screen.getByRole("group", { name: "Write the note, 10:30 to 11:15" });
    block.focus();
    fireEvent.keyDown(block, { key: "ArrowDown" });
    await waitFor(() => expect(acts).toHaveLength(1));
    // The day comes back holding 10:45: the note of what was written has nothing left to say.
    rerender(
      <Timeline
        date={DATE}
        meetings={[]}
        tasks={[{ ...blocked, blocks: [{ ...blocked.blocks[0], startsAt: `${DATE}T10:45:00` }] }]}
        onPatchTask={patchTask}
        onBlock={record}
        workHours="09:00-18:00"
      />,
    );
    fireEvent.keyDown(screen.getByRole("group", { name: "Write the note, 10:45 to 11:30" }), { key: "ArrowDown" });
    await waitFor(() => expect(acts.at(-1)).toEqual({ kind: "move", id: 1, startsAt: `${DATE}T11:00:00` }));
  });

  it("runs the column to midnight for a session that crosses it", () => {
    const late = { ...blocked, estimateMinutes: null, blocks: [{ id: 1, taskId: blocked.id, startsAt: `${DATE}T23:50:00`, minutes: 25, spentMinutes: 0 }] };
    const { container } = render(<Timeline date={DATE} meetings={[]} tasks={[late]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const labels = Array.from(container.querySelectorAll("span.font-mono")).map((el) => el.textContent).filter((t) => /^\d\d:00$/.test(t ?? ""));
    expect(labels.at(-1)).toBe("00:00");
    expect(screen.getByRole("group", { name: "Write the note, 23:50 to 00:15" }).style.top).toBe("890px");
  });

  it("keeps the resize handle out of the tab order", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[blocked]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const handle = resizeHandle(screen.getByRole("group", { name: "Write the note, 10:30 to 11:15" }));
    expect(handle.getAttribute("tabindex")).toBe("-1");
    expect(handle.getAttribute("aria-hidden")).toBe("true");
  });

  it("resizes a session by its bottom edge, in its own minutes", async () => {
    const { acts, onBlock: record } = stubBlocks();
    render(<Timeline date={DATE} meetings={[]} tasks={[blocked]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
    const block = screen.getByRole("group", { name: "Write the note, 10:30 to 11:15" });
    fireEvent.pointerDown(resizeHandle(block), { clientY: 200 });
    fireEvent.pointerMove(window, { clientY: 220 });
    fireEvent.pointerUp(window, { clientY: 220 });
    await waitFor(() => expect(acts).toEqual([{ kind: "resize", id: 1, minutes: 65 }]));
  });

  it("drops a cancelled resize, and a later release writes nothing", () => {
    const { acts, onBlock: record } = stubBlocks();
    render(<Timeline date={DATE} meetings={[]} tasks={[blocked]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
    const block = screen.getByRole("group", { name: "Write the note, 10:30 to 11:15" });
    fireEvent.pointerDown(resizeHandle(block), { clientY: 200 });
    fireEvent.pointerMove(window, { clientY: 220 });
    expect(block.style.height).toBe("65px");
    fireEvent.pointerCancel(window, { clientY: 220 });
    fireEvent.pointerUp(window, { clientY: 220 });
    expect(acts).toEqual([]);
  });

  it("hands the height back to the layout when a resize changes nothing", () => {
    const { acts, onBlock: record } = stubBlocks();
    render(<Timeline date={DATE} meetings={[]} tasks={[blocked]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
    const block = screen.getByRole("group", { name: "Write the note, 10:30 to 11:15" });
    fireEvent.pointerDown(resizeHandle(block), { clientY: 200 });
    fireEvent.pointerMove(window, { clientY: 220 });
    fireEvent.pointerUp(window, { clientY: 200 });
    expect(acts).toEqual([]);
    expect(block.style.height).toBe("45px");
  });

  it("brings the first session a row asked for into view and hands it the keyboard", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[twoSessions]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const block = screen.getByRole("group", { name: "Write the note · 1 of 2, 10:30 to 11:15" });
    // jsdom lays nothing out, so the scroll is only observed, not performed.
    const into = vi.fn();
    block.scrollIntoView = into;
    window.dispatchEvent(new CustomEvent("sb:timeline-focus", { detail: { taskId: blocked.id } }));
    expect(into).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(block);
  });

  it("goes to the session a chip names, not only to the task's first", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[twoSessions]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const second = screen.getByRole("group", { name: "Write the note · 2 of 2, 14:00 to 14:45" });
    window.dispatchEvent(new CustomEvent("sb:timeline-focus", { detail: { taskId: blocked.id, blockId: 2 } }));
    expect(document.activeElement).toBe(second);
  });

  it("falls back to the task's first session when the named one is gone", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[twoSessions]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const first = screen.getByRole("group", { name: "Write the note · 1 of 2, 10:30 to 11:15" });
    window.dispatchEvent(new CustomEvent("sb:timeline-focus", { detail: { taskId: blocked.id, blockId: 999 } }));
    expect(document.activeElement).toBe(first);
  });

  it("does nothing for a task with no session on the column", () => {
    render(<Timeline date={DATE} meetings={[]} tasks={[blocked]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const before = document.activeElement;
    window.dispatchEvent(new CustomEvent("sb:timeline-focus", { detail: { taskId: 999 } }));
    expect(document.activeElement).toBe(before);
  });

  it("completes a task from any of its sessions and dims a done one", async () => {
    const posts = stubPatch();
    render(<Timeline date={DATE} meetings={[]} tasks={[{ ...blocked, status: "done" }]} onPatchTask={patchTask} onBlock={onBlock} workHours="09:00-18:00" />);
    const block = screen.getByRole("group", { name: /Write the note/ });
    expect(block.className).toMatch(/opacity-50/);
    fireEvent.click(within(block).getByRole("checkbox"));
    await waitFor(() => expect(posts.at(-1)).toEqual({ id: blocked.id, body: { status: "open" } }));
  });

  describe("a session dropped for a task nobody estimated", () => {
    const unestimated: PlanTaskDTO = { ...blocked, id: 7, estimateMinutes: null, blocks: [] };
    const dropped = { ...unestimated, blocks: [{ id: NEW_BLOCK, taskId: 7, startsAt: `${DATE}T10:35:00`, minutes: 25, spentMinutes: 0 }] };
    const dt = { types: ["application/x-sb-plan"], getData: () => "7", dropEffect: "move" };

    /** Drops the row, then brings the day back holding the session the drop placed. */
    async function drop(record: (a: BlockAction) => BlockResult, acts: BlockAction[]) {
      const view = render(<Timeline date={DATE} meetings={[]} tasks={[unestimated]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
      fireEvent.drop(column(), { dataTransfer: dt, clientY: 100 + 93 });
      await waitFor(() => expect(acts).toHaveLength(1));
      view.rerender(<Timeline date={DATE} meetings={[]} tasks={[dropped]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
      return view;
    }

    it("asks how long it should be, and writes the answer to the task and the session", async () => {
      const posts = stubPatch();
      const { acts, onBlock: record } = stubBlocks();
      await drop(record, acts);
      const menu = await screen.findByRole("menu", { name: "Length" });
      expect(within(menu).getAllByRole("menuitemradio").map((b) => b.textContent)).toEqual(["15m", "25m", "45m", "1h", "1h 30m", "2h"]);
      fireEvent.click(within(menu).getByRole("menuitemradio", { name: "45m" }));
      await waitFor(() => expect(posts.at(-1)).toEqual({ id: 7, body: { estimateMinutes: 45 } }));
      await waitFor(() => expect(acts.at(-1)).toEqual({ kind: "resize", id: NEW_BLOCK, minutes: 45 }));
      expect(screen.queryByRole("menu", { name: "Length" })).toBeNull();
    });

    it("closes on escape with the keyboard back on the session, and stays closed", async () => {
      stubPatch();
      const { acts, onBlock: record } = stubBlocks();
      const view = await drop(record, acts);
      const menu = await screen.findByRole("menu", { name: "Length" });
      fireEvent.keyDown(menu, { key: "Escape" });
      const block = screen.getByRole("group", { name: "Write the note, 10:35 to 11:00" });
      expect(document.activeElement).toBe(block);
      expect(screen.queryByRole("menu", { name: "Length" })).toBeNull();
      // The day comes back again with the same session: the question was asked once.
      view.rerender(<Timeline date={DATE} meetings={[]} tasks={[dropped]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
      expect(screen.queryByRole("menu", { name: "Length" })).toBeNull();
      expect(acts).toHaveLength(1);
    });

    it("puts the question away when the pointer goes somewhere else", async () => {
      stubPatch();
      const { acts, onBlock: record } = stubBlocks();
      await drop(record, acts);
      await screen.findByRole("menu", { name: "Length" });
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("menu", { name: "Length" })).toBeNull();
      // Nothing was written by the press: only the drop that opened it stands.
      expect(acts).toHaveLength(1);
    });

    it("leaves the session alone when the estimate cannot be saved", async () => {
      // The task's estimate refuses: resizing the session to match would leave the two apart.
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/meetings/recorder" ? Response.json({ state: "idle", missing: [] }) : new Response(null, { status: 500 }))));
      const { acts, onBlock: record } = stubBlocks();
      await drop(record, acts);
      const menu = await screen.findByRole("menu", { name: "Length" });
      fireEvent.click(within(menu).getByRole("menuitemradio", { name: "45m" }));
      await waitFor(() => expect(screen.queryByRole("menu", { name: "Length" })).toBeNull());
      expect(acts).toEqual([{ kind: "add", taskId: 7, startsAt: `${DATE}T10:35:00`, minutes: 25 }]);
    });

    it("keeps the question up when a write beside it fails", async () => {
      stubPatch();
      const acts: BlockAction[] = [];
      // The add lands; everything after it is refused, the way a dead route answers.
      const record = async (action: BlockAction): BlockResult => {
        acts.push(action);
        return action.kind === "add" ? NEW_BLOCK : null;
      };
      await drop(record, acts);
      await screen.findByRole("menu", { name: "Length" });
      fireEvent.keyDown(screen.getByRole("group", { name: "Write the note, 10:35 to 11:00" }), { key: "ArrowDown" });
      await waitFor(() => expect(acts).toHaveLength(2));
      // The move never happened, so the question it would have answered is still standing.
      expect(screen.getByRole("menu", { name: "Length" })).toBeTruthy();
    });

    it("opens the question above a session near the foot of the column", async () => {
      stubPatch();
      const { acts, onBlock: record } = stubBlocks();
      const late = { ...unestimated, blocks: [{ id: NEW_BLOCK, taskId: 7, startsAt: `${DATE}T17:40:00`, minutes: 25, spentMinutes: 0 }] };
      const view = render(<Timeline date={DATE} meetings={[]} tasks={[unestimated]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
      // 17:40 on a column that ends at 18:00: below the block there is no room for the panel.
      fireEvent.drop(column(), { dataTransfer: dt, clientY: 100 + 520 });
      await waitFor(() => expect(acts).toHaveLength(1));
      view.rerender(<Timeline date={DATE} meetings={[]} tasks={[late]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
      expect((await screen.findByRole("menu", { name: "Length" })).className).toContain("bottom-full");
    });

    it("hangs the question below a session with room under it", async () => {
      stubPatch();
      const { acts, onBlock: record } = stubBlocks();
      await drop(record, acts);
      expect((await screen.findByRole("menu", { name: "Length" })).className).toContain("top-full");
    });

    it("asks nothing of a task that already carries an estimate", async () => {
      stubPatch();
      const { acts, onBlock: record } = stubBlocks();
      const estimated = { ...blocked, id: 7, blocks: [] };
      const { rerender } = render(<Timeline date={DATE} meetings={[]} tasks={[estimated]} onPatchTask={patchTask} onBlock={record} workHours="09:00-18:00" />);
      fireEvent.drop(column(), { dataTransfer: dt, clientY: 100 + 93 });
      await waitFor(() => expect(acts).toHaveLength(1));
      rerender(
        <Timeline
          date={DATE}
          meetings={[]}
          tasks={[{ ...estimated, blocks: [{ id: NEW_BLOCK, taskId: 7, startsAt: `${DATE}T10:35:00`, minutes: 45, spentMinutes: 0 }] }]}
          onPatchTask={patchTask}
          onBlock={record}
          workHours="09:00-18:00"
        />,
      );
      expect(screen.queryByRole("menu", { name: "Length" })).toBeNull();
    });
  });
});

/**
 * A 15-minute meeting is a 15px block (PX_PER_MIN = 1, MIN_HEIGHT = 15), and `p-2` is 16px of
 * vertical padding -- taller than the box it sits in. The title and the record control were pushed
 * below the block and clipped by `overflow-hidden`, which is what "short meetings are misaligned,
 * not in the centre" was.
 */
describe("a meeting too short to pad", () => {
  const short: MeetingListDTO = {
    ...sync,
    id: 91,
    title: "Standup",
    startsAt: `${DATE}T14:00:00`,
    endsAt: `${DATE}T14:15:00`,
    scheduledMs: 900_000,
    joinUrl: "",
  };

  function blockOf(name: string): HTMLElement {
    // The block is the positioned ancestor of its own open-button.
    const el = screen.getByRole("button", { name }).parentElement;
    if (!el) throw new Error("block not found");
    return el;
  }

  it("drops the vertical padding and centres the row instead of overflowing", () => {
    render(<Timeline date={DATE} meetings={[short]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    const content = blockOf("Standup, 14:00 to 14:15, 3 attendees").querySelector("div.relative");
    expect(content).toBeTruthy();
    expect(content!.className).toContain("justify-center");
    expect(content!.className).toContain("py-0");
    expect(content!.className).not.toContain("py-2");
  });

  it("keeps the vertical padding on a block with room for it", () => {
    render(<Timeline date={DATE} meetings={[sync]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    const content = blockOf("Product sync, 10:00 to 11:00, 3 attendees").querySelector("div.relative");
    expect(content!.className).toContain("py-2");
    expect(content!.className).not.toContain("justify-center");
  });

  // The row already carries the title and the length; the word "Record" does not fit beside them,
  // so the icon stands in. The accessible name must survive the swap.
  it("shows the record control as an icon, still named for a screen reader", () => {
    render(<Timeline date={DATE} meetings={[short]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    const record = screen.getByRole("button", { name: "Record Standup" });
    expect(record.textContent).toBe("");
    expect(record.querySelector("svg")).toBeTruthy();
  });

  it("still spells out Record when the block is tall enough", () => {
    render(<Timeline date={DATE} meetings={[sync]} tasks={[]} onPatchTask={patchTask} onBlock={onBlock} />);
    expect(screen.getByRole("button", { name: "Record Product sync" }).textContent).toBe("Record");
  });
});
