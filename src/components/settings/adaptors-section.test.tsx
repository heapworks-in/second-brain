// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AdaptorsSection } from "./adaptors-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** `status` is only passed by the tests that care about Accessibility; the rest get it missing,
 *  which is what an install that has never granted it looks like. */
function answer(body: unknown, status: unknown = {}) {
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
    if (init?.method === "POST") return new Response(null, { status: 204 });
    return String(input).includes("/api/activity/status") ? json(status) : json(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("AdaptorsSection", () => {
  it("gives the steps, the folder and a token button when the app bundled one", async () => {
    answer({ extensionPath: "/Users/x/Library/Application Support/com.second-brain.desktop/extension", token: "sekrit" });
    render(<AdaptorsSection />);
    expect(await screen.findByText(/com.second-brain.desktop\/extension/)).toBeTruthy();
    expect(screen.getByText("Load unpacked")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy token/ })).toBeTruthy();
  });

  it("opens the folder rather than asking anyone to find it", async () => {
    const fetchMock = answer({ extensionPath: "/somewhere/extension", token: "sekrit" });
    render(<AdaptorsSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Show/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/adaptors", { method: "POST" }));
  });

  it("copies the token, so nobody has to open a terminal for it", async () => {
    answer({ extensionPath: "/somewhere/extension", token: "sekrit" });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<AdaptorsSection />);
    fireEvent.click(await screen.findByRole("button", { name: /Copy token/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("sekrit"));
    expect(await screen.findByRole("button", { name: /Copied/ })).toBeTruthy();
  });

  it("names the exact binary the Accessibility grant has to point at", async () => {
    // macOS pins the grant to one file, and the path contains a space and can be moved by
    // set-data-dir -- so describing it in prose would not be actionable.
    answer(
      { extensionPath: "/somewhere/extension", token: "sekrit", helperPath: "/Users/x/Library/Application Support/second-brain/bin/sb-activity" },
      { helper: { permissions: { accessibility: false } } },
    );
    render(<AdaptorsSection />);
    expect(await screen.findByText(/second-brain\/bin\/sb-activity/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy path/ })).toBeTruthy();
    expect(screen.getByText(/needs Accessibility/)).toBeTruthy();
  });

  it("stops asking for a permission that is already granted", async () => {
    answer(
      { extensionPath: "/somewhere/extension", token: "sekrit", helperPath: "/somewhere/bin/sb-activity" },
      { helper: { permissions: { accessibility: true } } },
    );
    render(<AdaptorsSection />);
    expect(await screen.findByText(/Accessibility granted/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy path/ })).toBeNull();
  });

  it("points at the repo on an install with no bundled copy", async () => {
    // A `brain.sh`-managed checkout has no Tauri shell, so nothing unpacked an extension. The
    // section must not show a path that is not there.
    answer({ extensionPath: null, token: "sekrit" });
    render(<AdaptorsSection />);
    expect(await screen.findByText(/sb-adaptors/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy token/ })).toBeNull();
  });
});
