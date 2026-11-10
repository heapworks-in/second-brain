import { describe, it, expect } from "vitest";
import { detectIntent } from "./intent";

// Tuesday 22 September 2026, local. quickParse resolves "fri" to the next Friday, so 25th.
const now = new Date("2026-09-22T10:00:00");

describe("detectIntent", () => {
  it("links", () => {
    expect(detectIntent(" https://example.com/x ")).toEqual({ kind: "link", url: "https://example.com/x" });
  });
  it("tasks with + and /task", () => {
    expect(detectIntent("+ Call the bank fri", now)).toEqual({ kind: "task", title: "Call the bank", priority: "normal", dueDate: "2026-09-25", estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
    expect(detectIntent("/task !Ship it", now)).toEqual({ kind: "task", title: "Ship it", priority: "high", dueDate: null, estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
  });
  it("search with ? and /search", () => {
    expect(detectIntent("?tax forms")).toEqual({ kind: "search", query: "tax forms" });
    expect(detectIntent("/search tax")).toEqual({ kind: "search", query: "tax" });
  });
  it("links with /link", () => {
    expect(detectIntent("/link https://example.com/x")).toEqual({ kind: "link", url: "https://example.com/x" });
  });
  it("reads a bare command word as that kind with nothing in it", () => {
    expect(detectIntent("/note")).toEqual({ kind: "note", body: "" });
    expect(detectIntent("/search")).toEqual({ kind: "search", query: "" });
    expect(detectIntent("?")).toEqual({ kind: "search", query: "" });
    expect(detectIntent("/task", now)).toEqual({ kind: "task", title: "", priority: "normal", dueDate: null, estimateMinutes: null, sessionMinutes: null, requesterHandle: null });
    expect(detectIntent("/link")).toEqual({ kind: "link", url: "" });
  });
  it("notes by default and with /note", () => {
    expect(detectIntent("Remember the milk")).toEqual({ kind: "note", body: "Remember the milk" });
    expect(detectIntent("/note https://not-a-link.example is text")).toEqual({ kind: "note", body: "https://not-a-link.example is text" });
  });

  it("carries the estimate on a task intent", () => {
    expect(detectIntent("+ Write ~25m")).toMatchObject({ kind: "task", title: "Write", estimateMinutes: 25 });
  });

  it("carries the session length on a task intent", () => {
    expect(detectIntent("+ Deep work ~2h/45m")).toMatchObject({ kind: "task", title: "Deep work", estimateMinutes: 120, sessionMinutes: 45 });
  });
});
