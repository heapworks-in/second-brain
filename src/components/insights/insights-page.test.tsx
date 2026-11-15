// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Insight } from "@/domain/insights";
import { InsightsPage } from "./insights-page";

afterEach(cleanup);

function insight(over: Partial<Insight> = {}): Insight {
  return { id: "x", severity: "notable", headline: "Something is true", detail: "And here is why it matters", ...over };
}

describe("InsightsPage", () => {
  it("says the fact and why it matters", () => {
    render(<InsightsPage insights={[insight()]} />);
    expect(screen.getByRole("heading", { name: /Something is true/ })).toBeTruthy();
    expect(screen.getByText("And here is why it matters")).toBeTruthy();
  });

  it("leads with how many things are not working", () => {
    render(<InsightsPage insights={[insight({ severity: "blocked" }), insight({ id: "y" })]} />);
    expect(screen.getByText(/1 thing is not working/)).toBeTruthy();
  });

  it("links where there is somewhere to go, and does not invent one otherwise", () => {
    render(<InsightsPage insights={[insight({ href: "/settings", action: "Grant it" }), insight({ id: "y" })]} />);
    expect(screen.getByRole("link", { name: /Grant it/ }).getAttribute("href")).toBe("/settings");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("says plainly that it is asking nothing of you", () => {
    // The whole distinction from the desk. A page of statements that looked like a page of
    // demands would just be a second desk, and the first one was never answered.
    render(<InsightsPage insights={[insight()]} />);
    expect(screen.getByText(/asks you to decide anything/)).toBeTruthy();
  });

  it("has an empty state that means something", () => {
    render(<InsightsPage insights={[]} />);
    expect(screen.getByText(/Everything that should be arriving is/)).toBeTruthy();
  });

  it("names the severity for a screen reader, which cannot see the colour", () => {
    render(<InsightsPage insights={[insight({ severity: "blocked" })]} />);
    expect(screen.getByRole("heading", { name: /Not working/ })).toBeTruthy();
  });
});
