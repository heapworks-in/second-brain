// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { Dock } from "./dock";
import { ToastProvider } from "../shell/toasts";
import { resetFocusStore } from "../focus/focus-store";

const push = vi.fn();
const route = vi.hoisted(() => ({ path: "/inbox" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path, useRouter: () => ({ push }) }));

const FIELD = "Ask, capture, or add a task";
const ROWS = ["Home", "Desk, 2 waiting", "Planner", "Goals", "Review", "Log", "Inbox, 3 waiting", "Projects", "Areas", "Resources", "People", "Trackers", "Activity", "Library", "Archive", "Settings", "Help", "Search", "Capture"];

/** The polls the dock inherited from the sidebar, plus capture and the link it watches. */
function stubFetch(itemStatus = "pending") {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/inbox")) return Response.json({ count: 3 });
    if (url === "/api/desk") return Response.json({ proposals: [], open: 2, decidedToday: 0 });
    if (url.startsWith("/api/activity/status")) return Response.json({ helper: { lastSeen: new Date().toISOString() }, paused: false });
    if (/^\/api\/items\/\d+$/.test(url)) return Response.json({ id: 5, status: itemStatus });
    if (url === "/api/items") return Response.json({ id: 12, type: "note", title: "Buy milk" }, { status: 201 });
    // `FocusChip` polls this on mount; answered rather than left to the 404 fallback, whose
    // floating promise resolving at an arbitrary point was the suspected cause of an
    // intermittent flake here.
    if (url === "/api/focus") return Response.json({ run: null, settings: { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4 }, completedToday: 0 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** jsdom answers every query with `false`; the dock asks for the narrow layout and for
 * reduced motion, so the stub answers per query string. */
function stubMatchMedia(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("719px"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

function mount() {
  render(
    <ToastProvider>
      <Dock />
    </ToastProvider>,
  );
}

function labels(): (string | null)[] {
  const nav = screen.getByRole("navigation", { name: "Main" });
  return Array.from(nav.querySelectorAll("a,button")).map((el) => el.getAttribute("aria-label"));
}

function capture(): HTMLElement {
  return screen.getByRole("button", { name: "Capture" });
}

function shell(): HTMLElement {
  return document.querySelector("[data-dock-shell]") as HTMLElement;
}

function glow(): HTMLElement {
  return document.querySelector(".glow") as HTMLElement;
}

/** Opens the bar the way the Capture button does and hands back the field. */
async function openBar(): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Capture" }));
  return (await screen.findByRole("textbox", { name: FIELD })) as HTMLInputElement;
}

beforeEach(() => {
  route.path = "/inbox";
  stubFetch();
  stubMatchMedia(false);
  resetFocusStore();
});

afterEach(() => {
  cleanup();
  resetFocusStore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  push.mockClear();
});

describe("Dock", () => {
  it("lays the views out in order and marks the open one", async () => {
    mount();
    await waitFor(() => expect(labels()).toEqual(ROWS));
    expect(screen.getByRole("link", { name: "Inbox, 3 waiting" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Planner" }).getAttribute("aria-current")).toBeNull();
    // Home's href is a prefix of every other, so it must claim only itself.
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  });

  it("marks the view a nested route belongs to", () => {
    route.path = "/people/ana";
    mount();
    expect(screen.getByRole("link", { name: "People" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Planner" }).getAttribute("aria-current")).toBeNull();
  });

  it("counts the inbox into the row's label", async () => {
    mount();
    await waitFor(() => expect(screen.getByRole("link", { name: "Inbox, 3 waiting" })).toBeTruthy());
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("opens the bar for the capture shortcut and closes it on escape", async () => {
    mount();
    await waitFor(() => expect(capture()).toBeTruthy());
    expect(capture().getAttribute("aria-expanded")).toBe("false");
    act(() => {
      window.dispatchEvent(new Event("sb:prompt-focus"));
    });
    const field = await screen.findByRole("textbox", { name: FIELD });
    expect(document.activeElement).toBe(field);
    // The bar is the pill's expanded state, so the row of icons is not there beside it.
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: FIELD })).toBeNull());
    // Closing must not drop the caret on the body.
    expect(document.activeElement).toBe(capture());
    expect(capture().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the bar when capture is pressed", async () => {
    mount();
    expect(await openBar()).toBeTruthy();
  });

  it("keeps the draft when escape puts the pill back", async () => {
    mount();
    const field = await openBar();
    fireEvent.change(field, { target: { value: "buy mil" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy());
    // The nav coming back and focus landing on the capture button are two different ticks, so
    // this waits rather than asserting straight after the one above: under load the nav wins
    // that race and the focus assertion fails for a reason that has nothing to do with the dock.
    await waitFor(() => expect(document.activeElement).toBe(capture()));
    act(() => {
      window.dispatchEvent(new Event("sb:prompt-focus"));
    });
    const reopened = (await screen.findByRole("textbox", { name: FIELD })) as HTMLInputElement;
    expect(reopened.value).toBe("buy mil");
  });

  it("closes onto the capture button and spends the draft once the capture lands", async () => {
    mount();
    const field = await openBar();
    fireEvent.change(field, { target: { value: "Buy milk" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy());
    // Same two-tick race as above: the capture also has to land before the draft is spent.
    await waitFor(() => expect(document.activeElement).toBe(capture()));
    const reopened = await openBar();
    expect(reopened.value).toBe("");
  });

  it("breathes until the link the bar handed over has been read", async () => {
    vi.useFakeTimers();
    stubFetch("ready");
    mount();
    act(() => {
      window.dispatchEvent(new CustomEvent("sb:capture-pending", { detail: { itemId: 5 } }));
    });
    expect(glow().className).toContain("glow-breathing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(glow().className).not.toContain("glow-breathing");
  });

  it("steps back while the page is being typed in and comes forward on a pointer move", () => {
    mount();
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    fireEvent.focusIn(outside);
    expect(shell().className).toContain("opacity-40");
    fireEvent.pointerMove(document);
    expect(shell().className).not.toContain("opacity-40");
    outside.remove();
  });

  it("keeps five items on a narrow screen and puts the rest in the sheet", async () => {
    stubMatchMedia(true);
    mount();
    await waitFor(() => expect(labels()).toEqual(["Planner", "Inbox, 3 waiting", "Search", "Capture", "More"]));
    const more = screen.getByRole("button", { name: "More" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const sheet = screen.getByRole("list", { name: "More views" });
    expect(Array.from(sheet.querySelectorAll("a")).map((a) => a.textContent)).toEqual([
      expect.stringContaining("Home"),
      expect.stringContaining("Desk"),
      expect.stringContaining("Goals"),
      expect.stringContaining("Review"),
      expect.stringContaining("Log"),
      expect.stringContaining("Projects"),
      expect.stringContaining("Areas"),
      expect.stringContaining("Resources"),
      expect.stringContaining("People"),
      expect.stringContaining("Trackers"),
      expect.stringContaining("Activity"),
      expect.stringContaining("Library"),
      expect.stringContaining("Archive"),
      expect.stringContaining("Settings"),
      expect.stringContaining("Help"),
    ]);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("list", { name: "More views" })).toBeNull());
    expect(document.activeElement).toBe(more);
  });

  it("leaves focus to the page when a sheet row navigates", async () => {
    stubMatchMedia(true);
    mount();
    const more = await screen.findByRole("button", { name: "More" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("link", { name: /Projects/ }));
    await waitFor(() => expect(screen.queryByRole("list", { name: "More views" })).toBeNull());
    expect(document.activeElement).not.toBe(more);
  });
});
