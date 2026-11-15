// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AdaptorsSection } from "./adaptors-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function answer(body: unknown) {
  const fetchMock = vi.fn(async (_input: unknown, init?: { method?: string }) =>
    init?.method === "POST" ? new Response(null, { status: 204 }) : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
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

  it("points at the repo on an install with no bundled copy", async () => {
    // A `brain.sh`-managed checkout has no Tauri shell, so nothing unpacked an extension. The
    // section must not show a path that is not there.
    answer({ extensionPath: null, token: "sekrit" });
    render(<AdaptorsSection />);
    expect(await screen.findByText(/sb-adaptors/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy token/ })).toBeNull();
  });
});
