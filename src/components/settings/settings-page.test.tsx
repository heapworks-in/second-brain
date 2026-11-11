// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { SettingsPage, type SettingsPayload } from "./settings-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MODELS: SettingsPayload["models"] = {
  url: "http://127.0.0.1:11434",
  runtime: {
    reachable: true,
    version: "0.40.6",
    error: null,
    models: [
      { name: "gemma4:26b", size: 17_000_000_000 },
      { name: "gemma4:12b-it-qat", size: 7_200_000_000 },
    ],
  },
  configError: null,
  canRevert: false,
  roles: [
    { role: "summary", title: "Summary", what: "Meeting summaries", source: "none", model: null, wanted: null, unavailable: "no summary model is installed yet — install one in Settings › Setup" },
    { role: "gist", title: "Gist", what: "One-line gists", source: "local", model: "/models/gist/model.gguf", wanted: null, unavailable: null },
  ],
};

function payload(over: Partial<SettingsPayload> = {}): SettingsPayload {
  return {
    models: MODELS,
    identityNames: [],
    meetings: { autoRecord: false, autoRecordNeedsCallLink: true, audioRetentionDays: null },
    planner: { workHours: "09:00-17:30", workingDays: [1, 2, 3, 4, 5] },
    focus: { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" },
    ...over,
  };
}

/** Each section writes the route that already owns its setting; this records which. */
function stubPatches(answer: object = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "/api/settings/calendar") return Response.json({ feedUrl: "", syncedAt: null, error: null, count: 0 });
      return Response.json({ ...answer });
    }),
  );
  return calls;
}

describe("SettingsPage", () => {
  it("gathers every setting in one place", () => {
    stubPatches();
    render(<SettingsPage initial={payload()} />);
    for (const name of ["Models", "Calendar", "Meetings", "Planner", "Focus"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
  });

  describe("Models", () => {
    it("offers the models the runtime actually holds, not a text field to mistype into", () => {
      stubPatches();
      render(<SettingsPage initial={payload()} />);
      const select = screen.getByLabelText("Model for Summary") as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toEqual([
        "Decide automatically",
        "gemma4:26b · 15.8 GB",
        "gemma4:12b-it-qat · 6.7 GB",
      ]);
    });

    it("says where each role's answer is coming from", () => {
      stubPatches();
      render(<SettingsPage initial={payload()} />);
      expect(screen.getByText(/the copy installed beside the app/)).toBeTruthy();
      expect(screen.getByText(/no summary model is installed yet/)).toBeTruthy();
    });

    it("writes the chosen model to the roles route", async () => {
      const calls = stubPatches(MODELS);
      render(<SettingsPage initial={payload()} />);
      fireEvent.change(screen.getByLabelText("Model for Summary"), { target: { value: "gemma4:26b" } });
      await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/models" && c.method === "PATCH")).toBe(true));
      expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ role: "summary", model: "gemma4:26b" });
    });

    it("clearing a role hands it back to the fallback order rather than leaving it pointed at something", async () => {
      const calls = stubPatches(MODELS);
      render(<SettingsPage initial={payload({ models: { ...MODELS, roles: [{ ...MODELS.roles[0], wanted: "gemma4:26b", source: "config", model: "gemma4:26b", unavailable: null }, MODELS.roles[1]] } })} />);
      fireEvent.change(screen.getByLabelText("Model for Summary"), { target: { value: "" } });
      await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
      expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ role: "summary", model: null });
    });

    /** Dropping it would make the row read as though it had never been configured. */
    it("keeps showing a configured model the runtime no longer has, marked as missing", () => {
      stubPatches();
      render(
        <SettingsPage
          initial={payload({ models: { ...MODELS, roles: [{ ...MODELS.roles[0], wanted: "mistral:7b", unavailable: "the runtime does not have it" }, MODELS.roles[1]] } })}
        />,
      );
      const select = screen.getByLabelText("Model for Summary") as HTMLSelectElement;
      expect([...select.options].map((o) => o.textContent)).toContain("mistral:7b · not installed");
      expect(select.value).toBe("mistral:7b");
    });

    it("says what to do when there is no runtime, rather than only that there is none", () => {
      stubPatches();
      render(<SettingsPage initial={payload({ models: { ...MODELS, runtime: { reachable: false, version: null, error: "ECONNREFUSED", models: [] } } })} />);
      expect(screen.getByText(/brew install ollama/)).toBeTruthy();
    });

    it("reports a hand-edited file it cannot read, and says nothing in it is in force", () => {
      stubPatches();
      render(<SettingsPage initial={payload({ models: { ...MODELS, configError: "Unexpected token" } })} />);
      expect(screen.getByText(/nothing in it is in force/)).toBeTruthy();
    });

    it("offers to undo the last change only when there is something to undo", () => {
      stubPatches();
      const { unmount } = render(<SettingsPage initial={payload()} />);
      expect(screen.queryByRole("button", { name: "Undo the last change" })).toBeNull();
      unmount();
      render(<SettingsPage initial={payload({ models: { ...MODELS, canRevert: true } })} />);
      expect(screen.getByRole("button", { name: "Undo the last change" })).toBeTruthy();
    });

    it("undoes through the roles route", async () => {
      const calls = stubPatches(MODELS);
      render(<SettingsPage initial={payload({ models: { ...MODELS, canRevert: true } })} />);
      fireEvent.click(screen.getByRole("button", { name: "Undo the last change" }));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/models" && c.method === "DELETE")).toBe(true));
    });

    it("says so when a save is refused, and leaves the row as it was", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "the runtime does not have mistral:7b — pull it first" }, { status: 409 })));
      render(<SettingsPage initial={payload()} />);
      fireEvent.change(screen.getByLabelText("Model for Summary"), { target: { value: "gemma4:26b" } });
      expect(await screen.findByText(/pull it first/)).toBeTruthy();
    });
  });

  describe("Meetings", () => {
    it("saves each switch as it is flipped, to the route that owns it", async () => {
      const calls = stubPatches({ autoRecord: true, autoRecordNeedsCallLink: true, audioRetentionDays: null });
      render(<SettingsPage initial={payload()} />);
      fireEvent.click(screen.getByLabelText("Record meetings automatically"));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/meetings")).toBe(true));
      expect(calls.find((c) => c.url === "/api/settings/meetings")!.body).toEqual({ autoRecord: true });
    });

    /**
     * The hazard the old free-text retention field had: emptying it saved 0, which deletes audio
     * as soon as a transcript exists. A list of named windows removes the hazard by construction
     * — 0 is still reachable, but only by choosing the option that says what it does.
     */
    it("cannot save zero days by accident: every window is a named choice", async () => {
      const calls = stubPatches({ autoRecord: false, autoRecordNeedsCallLink: true, audioRetentionDays: 0 });
      render(<SettingsPage initial={payload()} />);
      const select = screen.getByLabelText("Keep the audio for") as HTMLSelectElement;
      expect(select.value).toBe("");
      expect([...select.options].map((o) => o.textContent)).toContain("Until the transcript is written");

      fireEvent.change(select, { target: { value: "0" } });
      await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/meetings")).toBe(true));
      expect(calls.find((c) => c.url === "/api/settings/meetings")!.body).toEqual({ audioRetentionDays: 0 });
    });

    it("keeps the audio for ever by default, and says that is the default", () => {
      stubPatches();
      render(<SettingsPage initial={payload()} />);
      expect((screen.getByLabelText("Keep the audio for") as HTMLSelectElement).value).toBe("");
      expect(screen.getByText(/Keeping it for ever is the default/)).toBeTruthy();
    });
  });

  describe("Planner and Focus", () => {
    it("writes working days to the planner route", async () => {
      const calls = stubPatches({ workHours: "09:00-17:30", workingDays: [1, 2, 3, 4] });
      render(<SettingsPage initial={payload()} />);
      fireEvent.click(screen.getByRole("button", { name: "Fri" }));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/planner")).toBe(true));
      expect(calls.find((c) => c.url === "/api/settings/planner")!.body).toEqual({ workingDays: [1, 2, 3, 4] });
    });

    it("saves working hours on blur rather than on every keystroke", async () => {
      const calls = stubPatches({ workHours: "08:00-16:00", workingDays: [1, 2, 3, 4, 5] });
      render(<SettingsPage initial={payload()} />);
      const field = screen.getByLabelText("Working hours");
      fireEvent.change(field, { target: { value: "08:00-16:00" } });
      expect(calls.filter((c) => c.url === "/api/settings/planner")).toHaveLength(0);
      fireEvent.blur(field);
      await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/planner")).toBe(true));
    });

    /** The reset has to be predictable, so it says what it will do before it is pressed. */
    it("names what a reset restores", () => {
      stubPatches();
      render(<SettingsPage initial={payload()} />);
      expect(screen.getByRole("button", { name: "Reset to 09:00-17:30, Mon–Fri" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reset to 25/5/15" })).toBeTruthy();
    });

    it("writes the focus rhythm to the focus route, and points at the other place it can be changed", async () => {
      const calls = stubPatches({ defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "timebox" });
      render(<SettingsPage initial={payload()} />);
      fireEvent.change(screen.getByLabelText("Rhythm"), { target: { value: "timebox" } });
      await waitFor(() => expect(calls.some((c) => c.url === "/api/settings/focus")).toBe(true));
      expect(calls.find((c) => c.url === "/api/settings/focus")!.body).toEqual({ mode: "timebox" });
      expect(screen.getByText(/Also switchable in the focus pane/)).toBeTruthy();
    });
  });

  it("holds the spellings of my own name, the one thing the app needs to know about me", async () => {
    const calls = stubPatches({ names: ["Avinash", "Avinash V"] });
    render(<SettingsPage initial={payload({ identityNames: ["Avinash"] })} />);
    const you = screen.getByLabelText("You");

    expect(within(you).getByText("Avinash")).toBeTruthy();
    fireEvent.change(within(you).getByLabelText("Add a spelling of your name"), { target: { value: "Avinash V" } });
    fireEvent.click(within(you).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ url: "/api/settings/identity", body: { names: ["Avinash", "Avinash V"] } }));

    // The list on screen is the server's answer, so removing works from what was actually saved.
    await waitFor(() => expect(within(you).getByText("Avinash V")).toBeTruthy());
    fireEvent.click(within(you).getByRole("button", { name: "Remove Avinash" }));
    await waitFor(() => expect(calls.at(-1)).toMatchObject({ url: "/api/settings/identity", body: { names: ["Avinash V"] } }));
  });
});
