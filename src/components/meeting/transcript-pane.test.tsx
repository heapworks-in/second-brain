// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { Segment } from "@/domain/meetings/transcript";
import { TranscriptPane, segmentStamp, timeOfDay } from "./transcript-pane";

afterEach(cleanup);

/** The pane with nothing happening: each test overrides only what it is about. */
const base = {
  live: [],
  segments: [] as Segment[],
  recording: false,
  startedAt: null as string | null,
  finalReady: true,
  transcribing: false,
  blocked: null,
  recordTitle: null,
  onRecord: () => {},
};

/**
 * An hour of speech used to make the page an hour long: the body was already
 * `flex-1 overflow-y-auto`, but nothing above it bounded the height, so there was nothing for it
 * to scroll within.
 */
describe("a long transcript", () => {
  const many: Segment[] = Array.from({ length: 400 }, (_, i) => ({
    start: i * 6,
    end: i * 6 + 6,
    text: `Line ${i} of a meeting that ran long.`,
  }));

  function paneOf(): HTMLElement {
    return screen.getByRole("region", { name: "Transcript" });
  }

  it("has a ceiling, so the body has something to scroll inside", () => {
    render(<TranscriptPane {...base} segments={many} />);
    const cls = paneOf().className;
    expect(cls).toContain("max-h-");
    expect(cls).toContain("min-h-");
  });

  it("scrolls the transcript itself rather than the page", () => {
    render(<TranscriptPane {...base} segments={many} />);
    const body = paneOf().querySelector(".overflow-y-auto");
    expect(body).toBeTruthy();
    expect(body!.className).toContain("flex-1");
  });

  it("still renders every line -- the cap is a viewport, not a limit on the transcript", () => {
    render(<TranscriptPane {...base} segments={many} />);
    expect(screen.getByText("Line 0 of a meeting that ran long.")).toBeTruthy();
    expect(screen.getByText("Line 399 of a meeting that ran long.")).toBeTruthy();
  });
});

/**
 * Every line says when it was said. The time of day is the useful form -- a transcript gets read
 * back against someone's memory of the meeting and against their calendar, not against an audio
 * scrubber, and there is no player here to scrub. The offset is still what a dropped-in file
 * knows about itself, so that is the fallback and the hover text.
 */
describe("when each line was said", () => {
  const STARTED = "2026-11-02T14:30:00.000Z";
  const segments: Segment[] = [
    { start: 0, end: 4, text: "Right, shall we start." },
    { start: 95.4, end: 99, text: "Tuesday night for the backfill." },
  ];

  it("stamps a recorded line with the time of day, worked out from the session's start", () => {
    render(<TranscriptPane {...base} segments={segments} startedAt={STARTED} />);
    expect(screen.getByText(timeOfDay(STARTED))).toBeTruthy();
    // 95.4 s in: a minute and 35 seconds past the start, to the second.
    expect(screen.getByText(timeOfDay(new Date(Date.parse(STARTED) + 95_400).toISOString()))).toBeTruthy();
  });

  it("keeps the offset into the recording as the hover text", () => {
    render(<TranscriptPane {...base} segments={segments} startedAt={STARTED} />);
    expect(screen.getByTitle("01:35 into the recording")).toBeTruthy();
  });

  // HH:MM would stamp every line of a busy minute identically, which is no stamp at all.
  it("distinguishes two lines inside the same minute", () => {
    render(
      <TranscriptPane
        {...base}
        startedAt={STARTED}
        segments={[
          { start: 2, end: 4, text: "First thing." },
          { start: 9, end: 11, text: "Second thing." },
        ]}
      />,
    );
    expect(segmentStamp(2, STARTED)).not.toBe(segmentStamp(9, STARTED));
    expect(screen.getByText(segmentStamp(9, STARTED))).toBeTruthy();
  });

  it("falls back to the offset for audio that was dropped in rather than recorded", () => {
    render(<TranscriptPane {...base} segments={segments} startedAt={null} />);
    expect(screen.getByText("00:00")).toBeTruthy();
    expect(screen.getByText("01:35")).toBeTruthy();
    expect(screen.queryByTitle(/into the recording/)).toBeNull();
  });

  // `at` has been on every live segment since the live pass was written and was dropped at render,
  // so the one transcript you read *while* a meeting runs was the one with no times on it.
  it("stamps the live lines too, from the wall clock each was heard at", () => {
    render(<TranscriptPane {...base} live={[{ at: "2026-11-02T14:31:07.000Z", text: "Half heard words." }]} recording />);
    expect(screen.getByText(timeOfDay("2026-11-02T14:31:07.000Z"))).toBeTruthy();
    expect(screen.getByText("Half heard words.")).toBeTruthy();
  });

  it("copies what it shows, stamps and all", async () => {
    const written: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: async (t: string) => void written.push(t) } });
    render(<TranscriptPane {...base} segments={segments} startedAt={STARTED} />);

    fireEvent.click(screen.getByRole("button", { name: /Copy transcript/ }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain(`${timeOfDay(STARTED)} Right, shall we start.`);
  });

  it("gives an unparseable stamp no text rather than NaN", () => {
    expect(timeOfDay("not a date")).toBe("");
    expect(segmentStamp(12, "not a date")).toBe("00:12");
  });
});
