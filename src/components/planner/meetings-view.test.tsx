// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { MeetingsView } from "./meetings-view";
import type { MeetingListDTO, MeetingSettingsDTO, RecorderStatusDTO } from "@/lib/dto";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: () => {} }),
  usePathname: () => "/planner/meetings",
}));

const TODAY = "2026-09-22";

function meeting(over: Partial<MeetingListDTO> & { id: number; title: string; startsAt: string; endsAt: string }): MeetingListDTO {
  return {
    attendees: 3,
    hasCallLink: false,
    interview: false,
    scheduledMs: 1800000,
    actualMs: 0,
    itemId: null,
    organizer: "Ada Lovelace",
    attendeeNames: [],
    location: "",
    joinUrl: null,
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
    ...over,
  };
}

const MEETINGS: MeetingListDTO[] = [
  meeting({ id: 1, title: "Standup", startsAt: `${TODAY}T09:30:00`, endsAt: `${TODAY}T09:45:00` }),
  meeting({
    id: 2,
    title: "Product sync",
    startsAt: "2026-09-23T10:30:00",
    endsAt: "2026-09-23T11:00:00",
    joinUrl: "https://meet.example.com/sync",
    hasCallLink: true,
    itemId: 7,
    item: { id: 7, hasNotes: true, hasTranscript: true, hasSummary: false, containerId: null },
  }),
  meeting({ id: 3, title: "Retro", startsAt: "2026-09-15T15:00:00", endsAt: "2026-09-15T16:00:00" }),
];

function mount() {
  render(<MeetingsView today={TODAY} meetings={MEETINGS} />);
}

/** The status the Record buttons read, and a record of the start they post. */
function stubRecorder(status: RecorderStatusDTO) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/meetings/recorder/start" && init?.method === "POST") {
      return Response.json({ ...status, state: "recording" });
    }
    if (String(input) === "/api/meetings/recorder") return Response.json(status);
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The settings the two switches read, kept across the PATCH the way the route keeps them. */
function stubSettings(initial: MeetingSettingsDTO) {
  let current = initial;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings/meetings" && init?.method === "PATCH") {
      current = { ...current, ...(JSON.parse(String(init.body)) as Partial<MeetingSettingsDTO>) };
      return Response.json(current);
    }
    if (url === "/api/settings/meetings") return Response.json(current);
    if (url === "/api/settings/calendar") return Response.json({ feedUrl: "", syncedAt: null, error: null, count: 0 });
    if (/\/api\/activity\/meetings\/\d+\/capture$/.test(url)) return Response.json({ id: 42 });
    if (url === "/api/meetings/recorder") return Response.json({ state: "idle", missing: [] });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** The switches and the feed link sit behind the gear once there are meetings on screen. */
function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: "Calendar settings" }));
}

/** By test id, not by role: the past group's rows sit inside a closed `details`. */
function titles(): string[] {
  return screen.getAllByTestId("meeting-title").map((el) => el.textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  nav.push.mockClear();
});

describe("MeetingsView", () => {
  it("groups today, the days ahead, and the past behind a disclosure", () => {
    mount();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Wednesday 23 September")).toBeTruthy();
    const past = screen.getByText("Past 30 days").closest("details") as HTMLDetailsElement;
    expect(past.open).toBe(false);
    expect(within(past).getByText("Retro")).toBeTruthy();
  });

  it("links to the audit from the header -- otherwise it has no way to be found in the app (F4)", () => {
    mount();
    expect(screen.getByRole("link", { name: "The audit" }).getAttribute("href")).toBe("/meetings/audit");
  });

  it("filters the rows as the search is typed", () => {
    mount();
    expect(titles()).toEqual(["Standup", "Product sync", "Retro"]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search meetings" }), { target: { value: "sync" } });
    expect(titles()).toEqual(["Product sync"]);
  });

  it("badges a meeting that has a transcript", () => {
    mount();
    const row = screen.getByText("Product sync").closest("li") as HTMLElement;
    expect(within(row).getByText("Transcript")).toBeTruthy();
    expect(within(row).queryByText("Summary")).toBeNull();
  });

  it("opens the call in a new tab without opening the meeting", () => {
    mount();
    const join = screen.getByRole("link", { name: "Join Product sync" });
    expect(join.getAttribute("href")).toBe("https://meet.example.com/sync");
    expect(join.getAttribute("target")).toBe("_blank");
    expect(join.getAttribute("rel")).toContain("noreferrer");
    fireEvent.click(join);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("says it once when there is nothing to list, rather than group by empty group", () => {
    render(<MeetingsView today={TODAY} meetings={[]} />);
    expect(screen.getByText("No meetings in the next 60 days")).toBeTruthy();
    expect(screen.queryByText("No meetings today")).toBeNull();
    expect(screen.queryByText("Past 30 days")).toBeNull();
    // The search box stays, so a filter that matches nothing can still be cleared.
    expect(screen.getByRole("searchbox", { name: "Search meetings" })).toBeTruthy();
  });

  it("says a search matched nothing and keeps the box that can clear it", () => {
    mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search meetings" }), { target: { value: "nothing matches this" } });
    expect(screen.getByText("No meetings match that search")).toBeTruthy();
    expect(screen.queryByTestId("meeting-title")).toBeNull();
  });

  it("records a row's meeting against its calendar event", async () => {
    const fetchMock = stubRecorder({ state: "idle", missing: [] });
    mount();
    const row = screen.getByText("Standup").closest("li") as HTMLElement;
    const record = within(row).getByRole("button", { name: "Record Standup" });
    await waitFor(() => expect(record.hasAttribute("disabled")).toBe(false));

    fireEvent.click(record);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url) === "/api/meetings/recorder/start");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call![1]?.body))).toEqual({ calendarEventId: 1 });
    });
  });

  it("starts an unplanned recording from the header", async () => {
    const fetchMock = stubRecorder({ state: "idle", missing: [] });
    mount();
    const record = screen.getByRole("button", { name: "Record now" });
    await waitFor(() => expect(record.hasAttribute("disabled")).toBe(false));

    fireEvent.click(record);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url) === "/api/meetings/recorder/start");
      expect(JSON.parse(String(call![1]?.body))).toEqual({ adhoc: true });
    });
  });

  it("says it is checking before the first answer, then lets go", async () => {
    stubRecorder({ state: "idle", missing: [] });
    mount();
    const record = screen.getByRole("button", { name: "Record now" });
    expect(record.hasAttribute("disabled")).toBe(true);
    expect(record.getAttribute("title")).toBe("Checking the recorder");
    await waitFor(() => expect(record.hasAttribute("disabled")).toBe(false));
    expect(record.hasAttribute("title")).toBe(false);
  });

  it("keeps record out of reach, and says why, while the recorder helper is missing", async () => {
    stubRecorder({ state: "idle", missing: ["recorder", "finalModel"] });
    mount();
    const record = screen.getByRole("button", { name: "Record now" });
    await waitFor(() => expect(record.getAttribute("title")).toBe("Recording needs the recorder helper. Run the setup script and reload"));
    expect(record.hasAttribute("disabled")).toBe(true);
  });

  it("still records when only the transcript tools are missing, and says what they are", async () => {
    // The meeting is captured to disk either way; the transcript catches up later.
    stubRecorder({ state: "idle", missing: ["whisper", "finalModel"] });
    mount();
    const record = screen.getByRole("button", { name: "Record now" });
    await waitFor(() => expect(record.getAttribute("title")).toBe("Transcription needs: whisper-cli, the final transcript model"));
    expect(record.hasAttribute("disabled")).toBe(false);
  });

  it("keeps the switches off screen until the settings answer, rather than guessing at them", async () => {
    stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
    mount();
    openSettings();
    expect(screen.queryByRole("switch", { name: "Record meetings automatically" })).toBeNull();

    const auto = await screen.findByRole("switch", { name: "Record meetings automatically" });
    expect(auto.getAttribute("aria-checked")).toBe("false");
    // The join-link rule only means something once meetings record themselves.
    expect(screen.queryByRole("switch", { name: "Only video calls" })).toBeNull();
  });

  it("saves each switch as it is flipped", async () => {
    const fetchMock = stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
    mount();
    openSettings();
    const auto = await screen.findByRole("switch", { name: "Record meetings automatically" });

    fireEvent.click(auto);
    await waitFor(() => expect(auto.getAttribute("aria-checked")).toBe("true"));
    const patch = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/settings/meetings" && init?.method === "PATCH");
    expect(JSON.parse(String(patch![1]?.body))).toEqual({ autoRecord: true });

    const link = screen.getByRole("switch", { name: "Only video calls" });
    expect(link.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(link);
    await waitFor(() => expect(link.getAttribute("aria-checked")).toBe("false"));
    const last = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH").at(-1);
    expect(JSON.parse(String(last![1]?.body))).toEqual({ autoRecordNeedsCallLink: false });
  });

  it("shows the audio retention window once settings answer, and saves a new day count on blur", async () => {
    const fetchMock = stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true, audioRetentionDays: 7 });
    mount();
    openSettings();

    const days = await screen.findByRole("spinbutton", { name: "Audio retention, in days" });
    expect((days as HTMLInputElement).value).toBe("7");

    fireEvent.change(days, { target: { value: "30" } });
    fireEvent.blur(days);
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/settings/meetings" && init?.method === "PATCH");
      expect(JSON.parse(String(patch![1]?.body))).toEqual({ audioRetentionDays: 30 });
    });
  });

  it("does not save an emptied retention field as 0, the most destructive value", async () => {
    // `Number("")` is 0, and 0 means "release the audio the moment a transcript exists" — the
    // exact opposite of what clearing a field to look at it means. A blank field must revert to
    // what was saved, not commit anything.
    const fetchMock = stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true, audioRetentionDays: 7 });
    mount();
    openSettings();

    const days = (await screen.findByRole("spinbutton", { name: "Audio retention, in days" })) as HTMLInputElement;
    fireEvent.change(days, { target: { value: "" } });
    fireEvent.blur(days);

    // Give any stray save a tick to land before asserting none did.
    await new Promise((r) => setTimeout(r, 0));
    const patch = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/settings/meetings" && init?.method === "PATCH");
    expect(patch).toBeUndefined();
    expect(days.value).toBe("7");
  });

  it("switches the audio retention window to keep forever, and back", async () => {
    const fetchMock = stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true, audioRetentionDays: 7 });
    mount();
    openSettings();

    const forever = await screen.findByRole("switch", { name: "Keep forever" });
    expect(forever.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(forever);
    await waitFor(() => expect(forever.getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByRole("spinbutton", { name: "Audio retention, in days" })).toBeNull();
    let patch = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH").at(-1);
    expect(JSON.parse(String(patch![1]?.body))).toEqual({ audioRetentionDays: null });

    fireEvent.click(forever);
    await waitFor(() => expect(forever.getAttribute("aria-checked")).toBe("false"));
    patch = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH").at(-1);
    expect(JSON.parse(String(patch![1]?.body))).toEqual({ audioRetentionDays: 7 });
  });

  it("does not render the audio retention control before settings have answered", () => {
    stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true, audioRetentionDays: 7 });
    mount();
    openSettings();
    expect(screen.queryByRole("spinbutton", { name: "Audio retention, in days" })).toBeNull();
  });

  it("keeps record out of reach while another meeting is recording", async () => {
    stubRecorder({ state: "recording", itemId: 4, title: "Retro", startedAt: new Date().toISOString(), missing: [] });
    mount();
    const record = screen.getByRole("button", { name: "Record now" });
    await waitFor(() => expect(record.getAttribute("title")).toBe("A recording is already running"));
    expect(record.hasAttribute("disabled")).toBe(true);
  });

  it("keeps the calendar settings behind the gear while there are meetings, and opens them when there are none", async () => {
    stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
    mount();
    expect(screen.queryByRole("region", { name: "Calendar settings" })).toBeNull();
    openSettings();
    expect(screen.getByRole("region", { name: "Calendar settings" })).toBeTruthy();
    expect(await screen.findByLabelText("Published calendar link")).toBeTruthy();
    cleanup();
    stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
    render(<MeetingsView today={TODAY} meetings={[]} />);
    expect(screen.getByRole("region", { name: "Calendar settings" })).toBeTruthy();
  });

  it("lists an all-day event as a chip with nothing to record or join", async () => {
    stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
    const holiday = meeting({ id: 9, title: "Dussehra", startsAt: `${TODAY}T00:00:00`, endsAt: "2026-09-24T00:00:00", allDay: true, attendees: 0, organizer: "" });
    render(<MeetingsView today={TODAY} meetings={[holiday, MEETINGS[0]]} />);
    const line = screen.getByLabelText("All day");
    expect(within(line).getByRole("button", { name: "Dussehra" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record Dussehra" })).toBeNull();
    expect(screen.getByRole("button", { name: "Record Standup" })).toBeTruthy();
    expect(screen.queryByText("0 attendees")).toBeNull();
    fireEvent.click(within(line).getByRole("button", { name: "Dussehra" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/items/42"));
  });

  it("keeps past all-day events to the chip line as well", () => {
    stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
    const past = meeting({ id: 8, title: "Onam", startsAt: "2026-09-15T00:00:00", endsAt: "2026-09-16T00:00:00", allDay: true, attendees: 0, organizer: "" });
    render(<MeetingsView today={TODAY} meetings={[past, MEETINGS[0]]} />);
    expect(screen.queryByRole("button", { name: "Record Onam" })).toBeNull();
    expect(screen.getAllByLabelText("All day").some((el) => within(el).queryByText("Onam"))).toBe(true);
  });

  describe("decisions", () => {
    const declined = meeting({ id: 10, title: "Skipped sync", startsAt: `${TODAY}T13:00:00`, endsAt: `${TODAY}T13:30:00`, decision: "not-going" });

    it("hides a not-going meeting by default, and 'Everything' brings it back -- never deleted, just hidden", () => {
      stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
      render(<MeetingsView today={TODAY} meetings={[MEETINGS[0], declined]} />);
      expect(screen.queryByTestId("meeting-title")).toBeTruthy();
      expect(screen.queryByText("Skipped sync")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Everything" }));
      expect(screen.getByText("Skipped sync")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Hide declined" }));
      expect(screen.queryByText("Skipped sync")).toBeNull();
    });

    it("shows only what is not going, the view design §5 is named for", () => {
      stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
      render(<MeetingsView today={TODAY} meetings={[MEETINGS[0], declined]} />);
      fireEvent.click(screen.getByRole("button", { name: "Only not going" }));
      expect(screen.getByText("Skipped sync")).toBeTruthy();
      expect(screen.queryByText("Standup")).toBeNull();
    });

    it("says why the list is empty when every meeting in the window is not going, rather than claiming there are none", () => {
      stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
      const onlyDeclined = meeting({ id: 11, title: "Only this one", startsAt: `${TODAY}T13:00:00`, endsAt: `${TODAY}T13:30:00`, decision: "not-going" });
      render(<MeetingsView today={TODAY} meetings={[onlyDeclined]} />);
      expect(screen.getByText('Everything in this window is marked not going. Switch to "Everything" to see it.')).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Only not going" }));
      expect(screen.getByText("Only this one")).toBeTruthy();
    });

    it("PATCHes a decision from the row control, local fact only -- never a message to a calendar server", async () => {
      const fetchMock = stubSettings({ autoRecord: false, autoRecordNeedsCallLink: true });
      render(<MeetingsView today={TODAY} meetings={[MEETINGS[0]]} />);
      const row = screen.getByText("Standup").closest("li") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: "Maybe" }));
      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/meetings/1/decision" && (init as RequestInit)?.method === "PATCH");
        expect(call).toBeTruthy();
        expect(JSON.parse(String(call![1]?.body))).toEqual({ decision: "maybe", scope: "occurrence" });
      });
    });
  });

  describe("the container suggestion", () => {
    const suggested = meeting({
      id: 20,
      title: "Kickoff",
      startsAt: `${TODAY}T14:00:00`,
      endsAt: `${TODAY}T14:30:00`,
      itemId: 30,
      item: { id: 30, hasNotes: false, hasTranscript: false, hasSummary: false, containerId: null },
      suggestedContainer: { id: 5, name: "Q3 Platform", slug: "q3-platform", kind: "project" },
    });

    /** The PATCH the offer's accept hits, and nothing else -- no path of its own. */
    function stubItemPatch() {
      const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (/\/api\/items\/\d+$/.test(String(input)) && init?.method === "PATCH") return Response.json({});
        return new Response("{}", { status: 404 });
      });
      vi.stubGlobal("fetch", fn);
      return fn;
    }

    it("offers a suggestion on an uncontained meeting, an offer only, never a write on its own", () => {
      render(<MeetingsView today={TODAY} meetings={[suggested]} />);
      expect(screen.getByText("Q3 Platform")).toBeTruthy();
      expect(screen.getByRole("button", { name: "File Kickoff there" })).toBeTruthy();
    });

    it("shows nothing for a meeting with no suggestion", () => {
      render(<MeetingsView today={TODAY} meetings={[MEETINGS[0]]} />);
      expect(screen.queryByRole("button", { name: "File Kickoff there" })).toBeNull();
    });

    it("accepting files the meeting's own item through the existing item PATCH, the only write this offer ever makes", async () => {
      const fetchMock = stubItemPatch();
      render(<MeetingsView today={TODAY} meetings={[suggested]} />);
      fireEvent.click(screen.getByRole("button", { name: "File Kickoff there" }));
      await waitFor(() => {
        const call = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/items/30" && (init as RequestInit)?.method === "PATCH");
        expect(call).toBeTruthy();
        expect(JSON.parse(String(call![1]?.body))).toEqual({ containerId: 5 });
      });
    });

    it("dismissing drops the offer for this session, without writing anything", () => {
      const fetchMock = stubItemPatch();
      render(<MeetingsView today={TODAY} meetings={[suggested]} />);
      fireEvent.click(screen.getByRole("button", { name: "Not this one for Kickoff" }));
      expect(screen.queryByText("Q3 Platform")).toBeNull();
      expect(fetchMock.mock.calls.some(([url]) => /\/api\/items\/\d+$/.test(String(url)))).toBe(false);
    });
  });

  describe("filtered to a project", () => {
    const filed = meeting({
      id: 21,
      title: "Roadmap review",
      startsAt: `${TODAY}T15:00:00`,
      endsAt: `${TODAY}T15:30:00`,
      itemId: 31,
      item: { id: 31, hasNotes: false, hasTranscript: false, hasSummary: false, containerId: 5 },
    });
    const filedElsewhere = meeting({
      id: 22,
      title: "Other project sync",
      startsAt: `${TODAY}T16:00:00`,
      endsAt: `${TODAY}T16:30:00`,
      itemId: 32,
      item: { id: 32, hasNotes: false, hasTranscript: false, hasSummary: false, containerId: 9 },
    });

    it("shows only meetings filed to the containerId prop the page resolved, with neutral copy that never assumes a project (review F3)", () => {
      render(<MeetingsView today={TODAY} meetings={[filed, filedElsewhere]} containerId={5} />);
      expect(screen.getByText("Roadmap review")).toBeTruthy();
      expect(screen.queryByText("Other project sync")).toBeNull();
      // "this project" would lie for an area's meetings -- MeetingsSection renders for both kinds.
      expect(screen.getByText("Showing only meetings filed here.")).toBeTruthy();
      expect(screen.getByText("Show all meetings")).toBeTruthy();
    });

    it("says no calendar meetings are filed, never a bare 'no meetings' this view can't verify (review F2 residual)", () => {
      // This view is calendar-sourced only, so it can never see an ad hoc or audio-only meeting
      // filed to the container -- the copy must not claim there are none of those either.
      render(<MeetingsView today={TODAY} meetings={[filedElsewhere]} containerId={5} />);
      expect(screen.getByText("No calendar meetings are filed here")).toBeTruthy();
    });

    it("shows everything with no containerId prop at all", () => {
      render(<MeetingsView today={TODAY} meetings={[filed, filedElsewhere]} />);
      expect(screen.getByText("Roadmap review")).toBeTruthy();
      expect(screen.getByText("Other project sync")).toBeTruthy();
      expect(screen.queryByText("Show all meetings")).toBeNull();
    });
  });
});
