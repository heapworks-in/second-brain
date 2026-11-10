// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { useRouter } from "next/navigation";
import { ContainerEditor } from "./container-editor";
import type { ContainerDTO, ContainerMeetingDTO, ItemDTO, TaskDTO } from "@/lib/dto";

// A single stable router object (not a fresh one per call) so tests can grab `replace` etc. up
// front via `useRouter()` and assert on the same spy instances the component used.
vi.mock("next/navigation", () => {
  const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
  return { useRouter: () => router };
});

// See item-editor.test.tsx / person-editor.test.tsx: this vitest config has no global
// `afterEach`, so @testing-library/react's auto-cleanup never registers and a mounted
// RichEditor's window keydown listener would otherwise outlive this test.
afterEach(cleanup);

const container: ContainerDTO = {
  id: 5,
  kind: "area",
  name: "Health",
  slug: "health",
  description: "Bio.\n",
  status: "active",
  goal: "",
  deadline: null,
  standard: "",
  nextSteps: "",
  category: null,
  sortOrder: 0,
  archivedAt: null,
  itemCount: 0,
  totalItemCount: 0,
  progress: { open: 0, done: 0, total: 0, percent: 0, nextTask: null },
  pinnedLinks: [],
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

// Polls a deadline rather than a fixed number of ticks: under full-suite parallel load the
// next/dynamic-loaded editor can take longer than a short fixed budget to mount.
const MOUNT_TIMEOUT_MS = 5000;
const MOUNT_POLL_MS = 20;

async function waitForEditor(hasEditor: () => boolean): Promise<void> {
  const deadline = Date.now() + MOUNT_TIMEOUT_MS;
  while (!hasEditor()) {
    if (Date.now() >= deadline) throw new Error("editor did not mount within 5 s");
    await act(async () => { await new Promise((r) => setTimeout(r, MOUNT_POLL_MS)); });
  }
}

// RichEditor debounces markdown emission 300ms after the last keystroke (EMIT_DEBOUNCE_MS in
// rich-editor.tsx); ContainerEditor then debounces the actual PATCH SAVE_DEBOUNCE_MS = 2000ms
// after that (container-editor.tsx). Both are host/editor behaviour frozen by this task, so the
// test waits out the real sum rather than a shortened one.
const EMIT_DEBOUNCE_MS = 300;
const SAVE_DEBOUNCE_MS = 2000;

const project: ContainerDTO = {
  ...container,
  id: 7,
  kind: "project",
  name: "Launch",
  slug: "launch",
  goal: "",
};

describe("ContainerEditor with RichEditor", () => {
  it("flushes the pending description edit and saves it on an immediate ⌘S", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patches.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ ...container, description: "x" }), { status: 200 });
        }
        return new Response(JSON.stringify(container), { status: 200 });
      }),
    );
    let editor: Editor | undefined;
    render(<ContainerEditor initial={container} items={[]} tasks={[]} today="2026-09-16" onEditorReady={(e) => (editor = e)} />);
    await waitForEditor(() => !!editor);
    expect(patches).toHaveLength(0);
    await act(async () => {
      editor!.commands.focus("end");
      editor!.commands.insertContent(" Typed just now");
    });
    // No wait for RichEditor's own 300ms emit debounce: ⌘S must flush it itself.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(patches).toHaveLength(1);
    expect((patches[0] as { description: string }).description).toContain("Bio. Typed just now");
    vi.unstubAllGlobals();
  });

  it("sends exactly one PATCH 2s after the editor's own debounce, without pressing anything", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patches.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ ...container, description: "x" }), { status: 200 });
        }
        return new Response(JSON.stringify(container), { status: 200 });
      }),
    );
    let editor: Editor | undefined;
    render(<ContainerEditor initial={container} items={[]} tasks={[]} today="2026-09-16" onEditorReady={(e) => (editor = e)} />);
    await waitForEditor(() => !!editor);
    expect(patches).toHaveLength(0);
    await act(async () => {
      editor!.commands.focus("end");
      editor!.commands.insertContent(" Autosaved");
    });
    // Two separate advances, not one: the first lets RichEditor's own 300ms debounce fire and
    // React flush the resulting setDescription/markDirty render before the second lets
    // ContainerEditor's 2000ms save debounce fire and read the now-current description from its ref.
    await act(async () => { vi.advanceTimersByTime(EMIT_DEBOUNCE_MS + 50); });
    await act(async () => { vi.advanceTimersByTime(SAVE_DEBOUNCE_MS + 100); });
    expect(patches).toHaveLength(1);
    expect((patches[0] as { description: string }).description).toContain("Bio. Autosaved");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("flushes immediately when the goal input blurs while dirty", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patches.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ ...project, goal: "Ship it" }), { status: 200 });
        }
        return new Response(JSON.stringify(project), { status: 200 });
      }),
    );
    let editor: Editor | undefined;
    const { getByPlaceholderText } = render(
      <ContainerEditor initial={project} items={[]} tasks={[]} today="2026-09-16" onEditorReady={(e) => (editor = e)} />,
    );
    await waitForEditor(() => !!editor);
    const goalInput = getByPlaceholderText("What does done look like?");
    fireEvent.change(goalInput, { target: { value: "Ship it" } });
    expect(patches).toHaveLength(0);
    await act(async () => {
      fireEvent.blur(goalInput);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(patches).toHaveLength(1);
    expect((patches[0] as { goal: string }).goal).toBe("Ship it");
    vi.unstubAllGlobals();
  });

  /**
   * The field is offered on every kind now, projects included. It used to be area and resource
   * only -- while the column and the route took it for any kind, so a project's next concrete
   * step was stored, accepted, and impossible to enter.
   */
  it("offers a next-steps field on a project as well as an area, and saves it on blur", async () => {
    const { queryByPlaceholderText: queryProject, unmount } = render(
      <ContainerEditor initial={project} items={[]} tasks={[]} today="2026-09-16" />,
    );
    expect(queryProject("What's the next concrete step here?")).not.toBeNull();
    unmount();

    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patches.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ ...container, nextSteps: "Call the physio" }), { status: 200 });
        }
        return new Response(JSON.stringify(container), { status: 200 });
      }),
    );
    let editor: Editor | undefined;
    const { getByPlaceholderText } = render(
      <ContainerEditor initial={container} items={[]} tasks={[]} today="2026-09-16" onEditorReady={(e) => (editor = e)} />,
    );
    await waitForEditor(() => !!editor);
    const nextStepsInput = getByPlaceholderText("What's the next concrete step here?");
    fireEvent.change(nextStepsInput, { target: { value: "Call the physio" } });
    await act(async () => {
      fireEvent.blur(nextStepsInput);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(patches).toHaveLength(1);
    expect((patches[0] as { nextSteps: string }).nextSteps).toBe("Call the physio");
    vi.unstubAllGlobals();
  });

  it("does not drop an edit made while a PATCH is already in flight, and ends 'Saved'", async () => {
    const patches: unknown[] = [];
    let resolveFirst!: (res: Response) => void;
    const firstPatch = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let patchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          patchCount += 1;
          const body = JSON.parse(String(init.body)) as { name: string };
          patches.push(body);
          // The first PATCH stays pending (deferred) until resolveFirst is called below, so a
          // second edit lands while it is still in flight; any later PATCH resolves right away.
          if (patchCount === 1) return firstPatch;
          return new Response(JSON.stringify({ ...container, name: body.name }), { status: 200 });
        }
        return new Response(JSON.stringify(container), { status: 200 });
      }),
    );
    let editor: Editor | undefined;
    const { getByPlaceholderText, getByText } = render(
      <ContainerEditor initial={container} items={[]} tasks={[]} today="2026-09-16" onEditorReady={(e) => (editor = e)} />,
    );
    await waitForEditor(() => !!editor);
    const nameInput = getByPlaceholderText("Name");

    fireEvent.change(nameInput, { target: { value: "First edit" } });
    await act(async () => {
      fireEvent.blur(nameInput);
    });
    expect(patches).toHaveLength(1);

    // A second edit, then another blur, while the first PATCH is still unresolved: it must not
    // be dropped, but it also must not fire yet — it's queued (pendingAgain) until the first
    // settles, exactly like item-editor.tsx's in-flight handling.
    fireEvent.change(nameInput, { target: { value: "Second edit" } });
    await act(async () => {
      fireEvent.blur(nameInput);
    });
    expect(patches).toHaveLength(1);

    await act(async () => {
      resolveFirst(new Response(JSON.stringify({ ...container, name: "First edit" }), { status: 200 }));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(patches).toHaveLength(2);
    expect((patches[1] as { name: string }).name).toBe("Second edit");
    expect(getByText("Saved")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("renaming, then unmounting within the debounce, saves without redirecting", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          const body = JSON.parse(String(init.body)) as { name: string };
          patches.push(body);
          return new Response(JSON.stringify({ ...container, name: body.name, slug: "wellness" }), { status: 200 });
        }
        return new Response(JSON.stringify(container), { status: 200 });
      }),
    );
    const { replace } = useRouter();
    vi.mocked(replace).mockClear();
    let editor: Editor | undefined;
    const { getByPlaceholderText, unmount } = render(
      <ContainerEditor initial={container} items={[]} tasks={[]} today="2026-09-16" onEditorReady={(e) => (editor = e)} />,
    );
    await waitForEditor(() => !!editor);
    const nameInput = getByPlaceholderText("Name");
    fireEvent.change(nameInput, { target: { value: "Wellness" } });
    // Unmount while the 2s save debounce is still pending, well before it would fire on its own.
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(patches).toHaveLength(1);
    expect((patches[0] as { name: string }).name).toBe("Wellness");
    expect(replace).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("a meeting filed to a resource (review F1)", () => {
  const resource: ContainerDTO = { ...container, id: 9, kind: "resource", name: "Reference", slug: "reference", category: "other" };
  const meetingItem: ItemDTO = {
    id: 50,
    type: "meeting",
    title: "Ad hoc call",
    body: "",
    status: "ready",
    error: null,
    sourceUrl: null,
    filePath: null,
    mimeType: null,
    extractedText: "",
    meta: {},
    tags: [],
    journalDate: null,
    reviewWeek: null,
    containerId: 9,
    container: null,
    archivedAt: null,
    pinned: false,
    people: [],
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };

  it("still lists it in the generic bucket, since MeetingsSection never renders for a resource", () => {
    const { getByRole } = render(<ContainerEditor initial={resource} items={[meetingItem]} tasks={[]} today="2026-09-16" />);
    expect(getByRole("link", { name: "Ad hoc call" })).toBeTruthy();
  });
});

describe("the project page's own Meetings section", () => {
  const meeting: ContainerMeetingDTO = {
    title: "Kickoff",
    startsAt: "2026-09-20T14:00:00.000Z",
    item: { id: 40, hasNotes: true, hasTranscript: false, hasSummary: true, containerId: 7 }, eventId: null,
  };

  it("lists a filed meeting with its date and its item's badges, not the generic 'Files and other items' bucket", () => {
    const { getByText, getByRole } = render(<ContainerEditor initial={project} items={[]} tasks={[]} meetings={[meeting]} today="2026-09-16" />);
    const row = getByRole("link", { name: "Kickoff" }).closest("li") as HTMLElement;
    expect(row.querySelector('a[href="/items/40"]')).toBeTruthy();
    // `meeting-row.tsx`'s own badge rule, reused rather than a second one: Notes and Summary
    // earned, Transcript not.
    expect(within(row).getByText("Notes")).toBeTruthy();
    expect(within(row).getByText("Summary")).toBeTruthy();
    expect(within(row).queryByText("Transcript")).toBeNull();
    // Nothing else filed here, so the generic bucket says so rather than repeating the meeting.
    expect(getByText("Nothing else filed here.")).toBeTruthy();
  });

  it("says nothing is filed yet when the container has no meetings", () => {
    const { getByText } = render(<ContainerEditor initial={project} items={[]} tasks={[]} meetings={[]} today="2026-09-16" />);
    expect(getByText("No meetings filed here yet.")).toBeTruthy();
  });

  it("links out to the project-filtered Planner view", () => {
    const { getByRole } = render(<ContainerEditor initial={project} items={[]} tasks={[]} meetings={[meeting]} today="2026-09-16" />);
    expect(getByRole("link", { name: "See calendar meetings in Planner" }).getAttribute("href")).toBe(`/planner/meetings?container=${project.id}`);
  });
});

/**
 * The pulse above the task list. Everything it shows was already in props and summed nowhere, so
 * a project's aggregate -- is it forecastable, is it slipping, did anything move -- was never on
 * screen.
 */
describe("the project pulse", () => {
  function tasks(over: Partial<TaskDTO>[] = []): TaskDTO[] {
    const base: TaskDTO = {
      id: 1, title: "A task", notes: "", status: "open", priority: "normal", dueDate: null, containerId: 1,
      sourceItemId: null, requester: null, askedOn: null, estimateMinutes: null, sessionMinutes: null, blocks: [], goals: [], spentMinutes: 0,
      likeThisMinutes: null, completedAt: null, sortOrder: 0, createdAt: "", updatedAt: "",
    };
    return over.map((o, i) => ({ ...base, id: 10 + i, ...o }));
  }

  it("sums estimate against spend, and flags what is overdue", () => {
    render(
      <ContainerEditor
        initial={container}
        items={[]}
        tasks={tasks([{ estimateMinutes: 60, spentMinutes: 90, dueDate: "2026-09-15" }, { estimateMinutes: 30 }])}
        today="2026-09-16"
      />,
    );
    const pulse = screen.getByRole("group", { name: "Project pulse" });
    expect(pulse.textContent).toContain("2 open");
    expect(pulse.textContent).toContain("1 overdue");
    expect(pulse.textContent).toContain("1h 30m / 1h 30m");
  });

  it("says what closed this week", () => {
    render(
      <ContainerEditor
        initial={container}
        items={[]}
        tasks={tasks([{ status: "done", completedAt: "2026-09-15T09:00:00.000Z" }])}
        today="2026-09-16"
      />,
    );
    expect(screen.getByRole("group", { name: "Project pulse" }).textContent).toContain("1 closed this week");
  });

  /** A project with nothing measured should not carry a row of zeroes. */
  it("is absent when there is nothing to say", () => {
    render(<ContainerEditor initial={container} items={[]} tasks={[]} today="2026-09-16" />);
    expect(screen.queryByRole("group", { name: "Project pulse" })).toBeNull();
  });

  // The list edits tasks in place, so a summary built from the render-time snapshot would stop
  // matching the rows beneath it the moment anything was ticked.
  it("follows the list rather than the snapshot it was rendered with", async () => {
    render(
      <ContainerEditor initial={container} items={[]} tasks={tasks([{ title: "Tick me" }, { title: "Leave me" }])} today="2026-09-16" />,
    );
    expect(screen.getByRole("group", { name: "Project pulse" }).textContent).toContain("2 open");

    await act(async () => {
      fireEvent.click(screen.getAllByRole("checkbox")[0]);
    });

    await waitFor(() => expect(screen.getByRole("group", { name: "Project pulse" }).textContent).toContain("1 open"));
  });
});
