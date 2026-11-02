"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Mic } from "lucide-react";
import type { Segment } from "@/domain/meetings/transcript";
import { Button, Input } from "../ui";

/** One guess the live pass made while the meeting was still running. */
export interface LiveSegmentDTO {
  at: string;
  text: string;
}

/** Seconds from the start of the recording, as the transcript shows them. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** The wall clock, to the second. `formatClock` in ../activity/format is the HH:MM one, which is
 *  right for a meeting's start and wrong here: a transcript puts several lines inside the same
 *  minute, and HH:MM would stamp a dozen of them identically. */
export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * When a line was said.
 *
 * The time of day, which is what someone reading a transcript back against their own memory or
 * their calendar actually wants, worked out from the session's start plus the offset whisper
 * reported. Dropped-in audio has no session behind it and so no time of day to give: those fall
 * back to the offset into the recording, which is all that file knows about itself.
 */
export function segmentStamp(start: number, startedAt: string | null): string {
  if (!startedAt) return clock(start);
  const began = Date.parse(startedAt);
  return Number.isNaN(began) ? clock(start) : timeOfDay(new Date(began + start * 1000).toISOString());
}

interface Props {
  live: LiveSegmentDTO[];
  segments: Segment[];
  /** True while the recorder is running: the live list is still growing. */
  recording: boolean;
  /** When the session began, so each line can say what time of day it was said. Null for audio
   *  that was dropped in rather than recorded. */
  startedAt: string | null;
  /** Set once the final pass has replaced the live guesses. */
  finalReady: boolean;
  /** True while the final pass is running, so the pane says so rather than looking empty. */
  transcribing: boolean;
  /** Why recording is out of reach, or null when the button is live. */
  blocked: string | null;
  recordTitle: string | null;
  onRecord: () => void;
}

/**
 * The right-hand pane: whatever the meeting has been heard to say. While recording it is the
 * live pass, appended to as it goes; afterwards it is the final transcript, timestamped and
 * filterable. Before either, it is the offer to start.
 */
export function TranscriptPane({ live, segments, recording, startedAt, finalReady, transcribing, blocked, recordTitle, onRecord }: Props) {
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  /** False once the reader scrolls up to read something, so new lines stop yanking them back. */
  const following = useRef(true);

  const needle = filter.trim().toLowerCase();
  const shown = needle ? segments.filter((s) => s.text.toLowerCase().includes(needle)) : segments;

  // A capped box that does not follow the tail is worse than an uncapped one during a meeting:
  // the newest line is the one being said, and it would sit just out of sight. So it follows --
  // but only while the reader is already at the bottom. Scrolling up to re-read something is a
  // deliberate act, and dragging them back down for every new line would undo it.
  const lastLine = segments.length > 0 ? `s${segments.length}` : `l${live.length}`;
  useEffect(() => {
    const el = scroller.current;
    if (!el || !following.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lastLine]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    // A couple of lines of slack: "at the bottom" should survive rounding and a half-scrolled line.
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  function copy() {
    const text = segments.map((s) => `${segmentStamp(s.start, startedAt)} ${s.text}`).join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }

  // `min-h` with no `max-h` is why this grew without bound: the body is already
  // `flex-1 overflow-y-auto`, but a flex child only scrolls when something above it limits the
  // height, and nothing did -- so an hour-long transcript simply made the page an hour long. The
  // ceiling is viewport-relative rather than a pixel count, so it still fills a large screen and
  // still fits on a laptop.
  return (
    <section className="pane flex flex-col min-h-[320px] max-h-[70vh]" aria-label="Transcript">
      <header className="flex items-center gap-2 px-4 h-11 border-b border-hairline">
        <span className="micro">Transcript</span>
        {recording && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-danger motion-safe:animate-pulse" aria-hidden />
            Listening
          </span>
        )}
        <span className="flex-1" />
        {segments.length > 0 && (
          <>
            <Input
              size="sm"
              aria-label="Filter transcript"
              placeholder="Filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-[14ch]"
            />
            <Button size="sm" variant="ghost" icon={Copy} onClick={copy}>
              {copied ? "Copied" : "Copy transcript"}
            </Button>
          </>
        )}
      </header>

      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3">
        {segments.length > 0 ? (
          shown.length === 0 ? (
            <p className="text-[13px] text-fg-faint">Nothing matches that</p>
          ) : (
            <ol role="list" className="list-none m-0 p-0 flex flex-col gap-1.5">
              {shown.map((s, i) => (
                <li key={`${s.start}-${i}`} className="flex gap-3 items-baseline">
                  <span
                    className="font-mono text-[11px] text-fg-faint tabular-nums shrink-0"
                    title={startedAt ? `${clock(s.start)} into the recording` : undefined}
                  >
                    {segmentStamp(s.start, startedAt)}
                  </span>
                  <span className="text-[13.5px] leading-relaxed">{s.text}</span>
                </li>
              ))}
            </ol>
          )
        ) : live.length > 0 ? (
          <ol role="list" className="list-none m-0 p-0 flex flex-col gap-1.5">
            {live.map((s, i) => (
              <li key={`${s.at}-${i}`} className="flex gap-3 items-baseline">
                {/* `at` has been on every live segment since the live pass was written (see
                    LiveSegment in domain/meetings/live.ts) and was simply dropped here, so the
                    one transcript you read *during* a meeting was the one with no times on it. */}
                <span className="font-mono text-[11px] text-fg-faint tabular-nums shrink-0">{timeOfDay(s.at)}</span>
                <span className="text-[13.5px] leading-relaxed text-fg-muted">{s.text}</span>
              </li>
            ))}
          </ol>
        ) : recording ? (
          <p className="text-[13px] text-fg-faint">The first lines appear once there is speech to transcribe</p>
        ) : transcribing ? (
          <p className="text-[13px] text-fg-faint">Transcribing the recording</p>
        ) : finalReady ? (
          <p className="text-[13px] text-fg-faint">The recording held nothing to transcribe</p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="text-[13px] text-fg-faint">No transcript yet</p>
            <span title={recordTitle ?? undefined}>
              <Button size="sm" icon={Mic} onClick={onRecord} disabled={!!blocked} title={recordTitle ?? undefined}>
                Start recording
              </Button>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
