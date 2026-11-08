// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { CalendarFeedDTO } from "@/lib/dto";
import { CalendarFeed } from "./calendar-feed";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const EMPTY: CalendarFeedDTO = { feedUrl: "", syncedAt: null, error: null, count: 0 };
const LINKED: CalendarFeedDTO = { feedUrl: "https://example.com/cal.ics", syncedAt: "2026-09-23T06:00:00.000Z", error: null, count: 7 };

function stub(initial: CalendarFeedDTO, answer: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method) return Response.json(initial);
      calls.push({ url, init });
      return answer(url, init);
    }),
  );
  return calls;
}

describe("CalendarFeed", () => {
  it("explains where the link comes from, then saves it and reports the sync", async () => {
    const onSynced = vi.fn();
    const calls = stub(EMPTY, () => Response.json({ ...LINKED, sync: { state: "ok", count: 7, syncedAt: LINKED.syncedAt } }));
    render(<CalendarFeed onSynced={onSynced} />);
    await screen.findByText(/Publish a calendar/);
    const input = screen.getByLabelText("Published calendar link");
    const save = screen.getByRole("button", { name: "Save link" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "webcal://example.com/cal.ics" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(/Synced 7 events/)).toBeTruthy());
    expect(calls[0]).toMatchObject({ url: "/api/settings/calendar", init: { method: "PATCH" } });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ feedUrl: "webcal://example.com/cal.ics" });
    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
  });

  it("shows the server's error for a link that does not work, and keeps the draft", async () => {
    stub(EMPTY, () => Response.json({ error: "The link must start with https:// or webcal://" }, { status: 400 }));
    render(<CalendarFeed />);
    const input = await screen.findByLabelText("Published calendar link");
    fireEvent.change(input, { target: { value: "ftp://x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save link" }));
    await screen.findByText("The link must start with https:// or webcal://");
    expect((input as HTMLInputElement).value).toBe("ftp://x");
  });

  it("syncs now for a linked feed and surfaces a failed sync", async () => {
    const calls = stub(LINKED, () => Response.json({ ...LINKED, error: "The link answered 404", sync: { state: "error", error: "The link answered 404" } }));
    render(<CalendarFeed />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    await screen.findByText("The link answered 404");
    expect(calls[0]).toMatchObject({ url: "/api/settings/calendar/sync", init: { method: "POST" } });
  });

  it("offers to remove a link that was cleared", async () => {
    stub(LINKED, () => Response.json(EMPTY));
    render(<CalendarFeed />);
    const input = await screen.findByLabelText("Published calendar link");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove link" }));
    await screen.findByText(/Publish a calendar/);
  });
});
