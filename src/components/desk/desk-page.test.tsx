// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { DeskDTO, ProposalDTO } from "@/lib/dto";
import { DeskPage } from "./desk-page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function card(over: Partial<ProposalDTO> = {}): ProposalDTO {
  return {
    id: 1,
    kind: "task_overrun",
    source: "task",
    title: "Write the migration",
    detail: "Estimated 1h, 2h 35m spent so far.",
    rank: 0.8,
    createdAt: "2026-11-08T09:00:00.000Z",
    dismissRate: 0,
    ...over,
  };
}

function desk(over: Partial<DeskDTO> = {}): DeskDTO {
  return { proposals: [card()], open: 1, decidedToday: 0, ...over };
}

/** The server answers an answer with the desk as it then stands, which is how the page advances. */
function stubDesk(after: DeskDTO, extra: Record<string, unknown> = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "POST" && url.startsWith("/api/desk/") && !url.endsWith("/refresh")) {
        return Response.json({ label: "Re-estimated to 2h 30m", undoable: true, desk: after, ...extra });
      }
      if (method === "DELETE") return Response.json({ undone: true, desk: desk() });
      if (url === "/api/desk") return Response.json(after);
      return Response.json({ queued: 1 });
    }),
  );
  return calls;
}

describe("DeskPage", () => {
  it("shows one card with its evidence and an answer named for its consequence", () => {
    render(<DeskPage initial={desk()} />);
    expect(screen.getByRole("heading", { name: "Write the migration" })).toBeTruthy();
    expect(screen.getByText("Estimated 1h, 2h 35m spent so far.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-estimate" })).toBeTruthy();
    // Never a generic accept.
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  /** One at a time is the whole design: a second card must not be on screen to be shopped for. */
  it("shows only the first of several, and says how many there are", () => {
    render(<DeskPage initial={desk({ proposals: [card(), card({ id: 2, title: "Answer the auditors" })], open: 2 })} />);
    expect(screen.getByRole("heading", { name: "Write the migration" })).toBeTruthy();
    expect(screen.queryByText("Answer the auditors")).toBeNull();
    expect(screen.getByRole("img", { name: "1 of 2 on the desk" })).toBeTruthy();
  });

  it("advances to the next card on one round trip, and counts the sitting", async () => {
    stubDesk(desk({ proposals: [card({ id: 2, title: "Answer the auditors" })], open: 1 }));
    render(<DeskPage initial={desk({ proposals: [card(), card({ id: 2, title: "Answer the auditors" })], open: 2 })} />);

    fireEvent.click(screen.getByRole("button", { name: "Re-estimate" }));
    expect(await screen.findByRole("heading", { name: "Answer the auditors" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "2 of 2 on the desk" })).toBeTruthy();
  });

  it("offers to take an acceptance back rather than asking first", async () => {
    const calls = stubDesk(desk({ proposals: [], open: 0 }));
    render(<DeskPage initial={desk()} />);
    fireEvent.click(screen.getByRole("button", { name: "Re-estimate" }));

    expect(await screen.findByText("Re-estimated to 2h 30m.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByRole("heading", { name: "Write the migration" })).toBeTruthy();
  });

  it("offers nothing to undo for a snooze or a dismissal", async () => {
    stubDesk(desk({ proposals: [], open: 0 }), { label: "Back in 7 days", undoable: false });
    render(<DeskPage initial={desk()} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByText("Back in 7 days.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("sends the decision the button names", async () => {
    const calls = stubDesk(desk({ proposals: [], open: 0 }));
    render(<DeskPage initial={desk()} />);
    fireEvent.click(screen.getByRole("button", { name: "Never" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ decision: "dismiss" });
  });

  describe("the keyboard", () => {
    it("answers with Enter, a full stop and n, because the actions differ per card", async () => {
      const calls = stubDesk(desk({ proposals: [], open: 0 }));
      render(<DeskPage initial={desk()} />);

      fireEvent.keyDown(window, { key: "Enter" });
      await waitFor(() => expect(calls.length).toBeGreaterThan(0));
      expect(calls[0].body).toEqual({ decision: "accept" });
    });

    it("takes . for not now and n for never", async () => {
      const calls = stubDesk(desk({ proposals: [card({ id: 9 })], open: 1 }));
      render(<DeskPage initial={desk()} />);
      fireEvent.keyDown(window, { key: "." });
      await waitFor(() => expect(calls.length).toBeGreaterThan(0));
      expect(calls[0].body).toEqual({ decision: "snooze" });

      cleanup();
      const more = stubDesk(desk({ proposals: [], open: 0 }));
      render(<DeskPage initial={desk()} />);
      fireEvent.keyDown(window, { key: "n" });
      await waitFor(() => expect(more.length).toBeGreaterThan(0));
      expect(more[0].body).toEqual({ decision: "dismiss" });
    });

    it("stays out of the way of anything being typed into", async () => {
      const calls = stubDesk(desk({ proposals: [], open: 0 }));
      render(
        <>
          <input aria-label="somewhere to type" />
          <DeskPage initial={desk()} />
        </>,
      );
      const input = screen.getByLabelText("somewhere to type");
      input.focus();
      fireEvent.keyDown(input, { key: "n" });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toHaveLength(0);
    });
  });

  describe("the empty desk", () => {
    it("is one line when there was nothing to do", () => {
      render(<DeskPage initial={{ proposals: [], open: 0, decidedToday: 0 }} />);
      expect(screen.getByText("Desk clear.")).toBeTruthy();
    });

    /** The count is the reason to come back tomorrow. */
    it("says what the sitting was worth once it has been cleared", async () => {
      stubDesk({ proposals: [], open: 0, decidedToday: 1 });
      render(<DeskPage initial={desk()} />);
      fireEvent.click(screen.getByRole("button", { name: "Re-estimate" }));
      expect(await screen.findByText("Desk clear — 1 decision made.")).toBeTruthy();
    });
  });

  describe("why am I seeing this", () => {
    it("says nothing about a kind that is usually accepted", () => {
      render(<DeskPage initial={desk({ proposals: [card({ dismissRate: 0.2 })] })} />);
      expect(screen.queryByText(/refuse/)).toBeNull();
    });

    it("admits to a kind that keeps being refused, so its place in the list is legible", () => {
      render(<DeskPage initial={desk({ proposals: [card({ dismissRate: 0.6 })] })} />);
      expect(screen.getByText("You refuse about 60% of these.")).toBeTruthy();
    });

    it("says it plainly when every one has been refused", () => {
      render(<DeskPage initial={desk({ proposals: [card({ dismissRate: 1 })] })} />);
      expect(screen.getByText("You have refused every one of these so far.")).toBeTruthy();
    });
  });

  it("says so rather than going blank when an answer fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "That has already been answered" }, { status: 409 })));
    render(<DeskPage initial={desk()} />);
    fireEvent.click(screen.getByRole("button", { name: "Re-estimate" }));
    expect(await screen.findByText("That has already been answered")).toBeTruthy();
    // The card is still there to try again with.
    expect(screen.getByRole("heading", { name: "Write the migration" })).toBeTruthy();
  });
});
