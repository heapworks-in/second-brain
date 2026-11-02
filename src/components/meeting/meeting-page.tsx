"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft, ExternalLink, Mic, Square } from "lucide-react";
import type { ActivityMeetingDTO, ItemDTO, TaskDTO } from "@/lib/dto";
import type { RecordingMeta } from "@/domain/meetings/recorder";
import type { Segment } from "@/domain/meetings/transcript";
import { Button, Chip } from "../ui";
import { StatusDot } from "../type-icon";
import { Crumb } from "../shell/crumb";
import { ContainerPicker } from "../container-picker";
import { useItemAutosave } from "../document/use-item-autosave";
import { useRecorder } from "../planner/use-recorder";
import { formatClock, formatDayHeading, todayLocal } from "../activity/format";
import { MeetingRail } from "./meeting-rail";
import { SummaryPane, type MeetingSummaryMeta, type TaskHome } from "./summary-pane";
import { TranscriptPane, type LiveSegmentDTO } from "./transcript-pane";

const RichEditor = dynamic(() => import("../editor/rich-editor").then((m) => m.RichEditor), {
  ssr: false,
  loading: () => <div className="doc rich-editor" aria-busy="true" />,
});

/** Ruling: three seconds while there is something to catch up with, and not a beat otherwise. */
const POLL_MS = 3000;
/** How long the page keeps looking for a summary after the transcript lands. */
const SUMMARY_WAIT_MS = 5 * 60_000;
const TICK_MS = 1000;

/** Everything the meeting page reads out of `item.meta`. */
export interface MeetingMeta {
  recording?: RecordingMeta;
  liveTranscript?: LiveSegmentDTO[];
  transcript?: Segment[];
  final_transcript_ready?: boolean;
  summary?: MeetingSummaryMeta;
  summaryError?: string;
  summaryGaps?: string;
  acceptedActions?: number[];
  calendarEventId?: number;
  /** Design §9: set once `releaseAudio` has deleted the wav, either by the nightly pass or the
   * "Remove the audio" action. */
  audioReleasedAt?: string;
}

export interface MeetingPageProps {
  item: ItemDTO;
  /** The calendar row this meeting came from, when it came from one. */
  event: ActivityMeetingDTO | null;
  /** Tasks whose `sourceItemId` is this meeting. */
  tasks: TaskDTO[];
  /** Whether the local summary model is installed, which is why there may be no summary. */
  hasSummaryModel: boolean;
  /** Size of the recorded WAV on disk, measured on the server. */
  recordingBytes: number | null;
}

function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** How long the recording ran, from the session's own stamps or the transcript's last line. */
function recordedSeconds(rec: RecordingMeta | undefined, segments: Segment[]): number | null {
  if (rec?.endedAt) return (Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 1000;
  if (segments.length > 0) return segments[segments.length - 1].end;
  return null;
}

/**
 * A meeting is not a note with a different icon: it has a time, people, a recording, a
 * transcript, and a summary that proposes work. This is that page — the item editor's
 * autosave for the title and the notes, and everything else the meeting itself.
 */
export function MeetingPage({ item: initial, event, tasks, hasSummaryModel, recordingBytes }: MeetingPageProps) {
  const auto = useItemAutosave(initial.id, initial);
  const { item, title, body, save, saveLabel, setTitle, setBody, persist, syncFromServer } = auto;
  const recorder = useRecorder();

  const [now, setNow] = useState(0);
  const [movePicker, setMovePicker] = useState(false);
  // The item's own record is the truth; this only carries a row until the next poll.
  const [acceptedHere, setAcceptedHere] = useState<number[]>([]);
  const [added, setAdded] = useState<TaskDTO[]>([]);
  const [stopError, setStopError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  const meta = item.meta as MeetingMeta;
  const recording = meta.recording;
  const live = meta.liveTranscript ?? [];
  const segments = meta.transcript ?? [];
  const finalReady = !!meta.final_transcript_ready;
  const isRecording = recording?.state === "recording";
  // The rule that cannot be broken (design §9.1) is checked server-side at the moment of
  // deletion; this only decides whether to offer the button at all -- against the transcript
  // itself, not `final_transcript_ready`, which is a flag set once and proves nothing about
  // what is on the item right now.
  const canRemoveAudio = !!recording?.wavPath && !meta.audioReleasedAt && item.extractedText.trim().length > 0;
  // Ruling: poll while the recorder runs or the final pass is still working, and stop the
  // moment the transcript lands or the item settles either way.
  const polling = !finalReady && (isRecording || item.status === "processing");
  // The summary is written by a job that starts after the transcript lands, so the page keeps
  // looking a little longer, when there is a local model to write one with.
  const summaryDue = hasSummaryModel && finalReady && !meta.summary && !meta.summaryError;
  // True while a pass is believed to be on its way. Not simply `summaryDue`: the Summarise
  // button sets it while that is already false, and it has to be releasable, because a pass
  // that never arrives would otherwise leave the button disabled and the pane saying "No
  // summary yet" with nothing to press -- which is the whole bug. React's documented
  // adjust-state-on-change pattern, so the transcript landing still starts the watch.
  const [summaryPending, setSummaryPending] = useState(summaryDue);
  const [watchedDue, setWatchedDue] = useState(summaryDue);
  if (watchedDue !== summaryDue) {
    setWatchedDue(summaryDue);
    setSummaryPending(summaryDue);
  }
  // Dropped-in audio is transcribed the same way, and has no recording session of its own.
  const transcribing = !isRecording && !finalReady && item.status === "processing";

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/items/${initial.id}`, { cache: "no-store" });
      if (!res.ok) return;
      syncFromServer((await res.json()) as ItemDTO);
    } catch {
      /* offline: the next tick tries again */
    }
  }, [initial.id, syncFromServer]);

  useEffect(() => {
    // The event fires when a recording starts or stops anywhere, which is what turns polling
    // on in the first place; without it a page that started the recording would sit still.
    const onChanged = () => void refresh();
    window.addEventListener("sb:recording-changed", onChanged);
    return () => window.removeEventListener("sb:recording-changed", onChanged);
  }, [refresh]);

  useEffect(() => {
    if (!polling && !summaryPending) return;
    const since = Date.now();
    const timer = setInterval(() => {
      if (!polling && Date.now() - since > SUMMARY_WAIT_MS) {
        clearInterval(timer);
        // A pass that failed with the same message it failed with last time changes nothing on
        // the item, so giving up watching is the only thing that can release the button.
        setSummaryPending(false);
        return;
      }
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, summaryPending, refresh]);

  useEffect(() => {
    if (!isRecording) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [isRecording]);

  function stop() {
    setStopError(null);
    void (async () => {
      try {
        const res = await fetch("/api/meetings/recorder/stop", { method: "POST" });
        if (!res.ok) setStopError("Could not stop the recording");
      } catch {
        setStopError("Could not stop the recording");
      } finally {
        window.dispatchEvent(new Event("sb:recording-changed"));
      }
    })();
  }

  /** Reclaims the audio now rather than waiting for design §9's window -- the server checks the
   * rule that cannot be broken again itself, regardless of what `canRemoveAudio` decided here. */
  function removeAudio() {
    setAudioError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/meetings/${initial.id}/audio`, { method: "DELETE" });
        if (!res.ok) {
          setAudioError("Could not remove the audio");
          return;
        }
        await refresh();
      } catch {
        setAudioError("Could not remove the audio");
      }
    })();
  }

  const home: TaskHome = item.container ? { label: item.container.name, href: `/c/${item.container.slug}` } : { label: "Inbox", href: "/inbox" };
  const parent = event ? { label: "Meetings", href: "/planner/meetings" } : { label: "Library", href: "/library" };
  const elapsed = recording?.startedAt ? elapsedClock(now - Date.parse(recording.startedAt)) : "00:00";
  const linkedTasks = [...tasks, ...added.filter((t) => !tasks.some((existing) => existing.id === t.id))];
  const accepted = [...new Set([...(meta.acceptedActions ?? []), ...acceptedHere])];

  return (
    <div className="w-full px-6 lg:px-8 pt-8 pb-10 flex flex-col gap-4">
      <Crumb title={title || "Untitled"} parent={parent} />
      <MeetingRail
        item={item}
        event={event}
        tasks={linkedTasks}
        recordingSeconds={recordedSeconds(recording, segments)}
        recordingBytes={recordingBytes}
        audioReleasedAt={meta.audioReleasedAt ?? null}
        canRemoveAudio={canRemoveAudio}
        onRemoveAudio={removeAudio}
        home={home}
        onMove={() => setMovePicker(true)}
      />

      <header className="flex items-center gap-2 h-10">
        <Link href={parent.href} className="focus-ring inline-flex items-center gap-1 text-[12.5px] text-fg-muted hover:text-fg rounded-sm">
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden />
          {parent.label}
        </Link>
        <span className="font-mono text-[11px] text-fg-faint">#{item.id}</span>
        <StatusDot status={item.status} error={item.error} />
        <span className={`text-[12px] ${save === "error" ? "text-danger" : "text-fg-faint"}`}>{saveLabel}</span>
      </header>

      {item.error && <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">{item.error}</div>}
      {stopError && <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">{stopError}</div>}
      {audioError && <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">{audioError}</div>}
      {recorder.error && <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">{recorder.error}</div>}

      <input
        aria-label="Meeting title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (save === "dirty") void persist();
        }}
        className="font-doc text-[32px] leading-[1.15] font-medium bg-transparent outline-none focus-ring w-full"
        placeholder="Untitled"
      />

      <div className="flex items-center gap-2 flex-wrap text-[12.5px] text-fg-muted">
        {event && (
          <>
            <span>{formatDayHeading(todayLocal(new Date(event.startsAt)))}</span>
            <span className="font-mono text-[12px] tabular-nums">
              {event.allDay ? "all day" : `${formatClock(event.startsAt)}–${formatClock(event.endsAt)}`}
            </span>
            {event.organizer && <span className="text-fg-faint">{event.organizer}</span>}
            {event.attendeeNames.map((name) => (
              <Chip as="span" key={name}>
                {name}
              </Chip>
            ))}
            {event.joinUrl && (
              <Button href={event.joinUrl} size="sm" variant="ghost" icon={ExternalLink} target="_blank" rel="noreferrer" aria-label={`Join ${event.title}`}>
                Join
              </Button>
            )}
          </>
        )}
        <span className="flex-1" />
        {isRecording ? (
          <span className="inline-flex items-center gap-2">
            {/* Only the stable half is live: a clock inside a live region is announced every second. */}
            <span role="status" aria-live="polite" className="inline-flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-danger motion-safe:animate-pulse" aria-hidden />
              <span className="text-[12.5px]">Recording</span>
            </span>
            <span className="font-mono text-[12px] tabular-nums" aria-hidden>
              {elapsed}
            </span>
            <Button size="sm" variant="danger" icon={Square} aria-label="Stop recording" onClick={stop}>
              Stop
            </Button>
          </span>
        ) : transcribing ? (
          <span role="status" aria-live="polite" className="text-[12.5px]">
            Transcribing
          </span>
        ) : (
          <span title={recorder.title ?? undefined}>
            {/* A finished transcript used to replace this button with the word "Done", which left
                no way to record again from the meeting it belongs to -- a meeting that resumed, or
                a stop hit by mistake, had nowhere to go. Recording again archives the transcript
                that is already there rather than overwriting it (see startRecording). */}
            <Button size="sm" icon={Mic} disabled={!!recorder.blocked} title={recorder.title ?? undefined} onClick={() => recorder.record({ itemId: item.id })}>
              {finalReady ? "Record again" : "Record"}
            </Button>
          </span>
        )}
      </div>

      <div className="grid gap-4 grid-cols-1 min-[1100px]:grid-cols-2 items-start">
        <section className="pane flex flex-col min-h-[320px]" aria-label="Notes">
          <header className="flex items-center gap-2 px-4 h-11 border-b border-hairline">
            <span className="micro">Notes</span>
          </header>
          <div className="px-4 py-3">
            <RichEditor
              value={body}
              itemId={initial.id}
              onChange={setBody}
              onBlur={() => {
                if (save === "dirty") void persist();
              }}
              placeholder="What was said, and what it means"
            />
          </div>
        </section>

        <TranscriptPane
          live={live}
          segments={segments}
          recording={isRecording}
          finalReady={finalReady}
          transcribing={transcribing}
          blocked={recorder.blocked}
          recordTitle={recorder.title}
          onRecord={() => recorder.record({ itemId: item.id })}
        />
      </div>

      <SummaryPane
        itemId={initial.id}
        title={item.title}
        summary={meta.summary}
        summaryError={meta.summaryError}
        summaryGaps={meta.summaryGaps}
        hasSummaryModel={hasSummaryModel}
        canSummarize={item.extractedText.trim().length > 0 || body.trim().length > 0}
        pending={summaryPending}
        onQueued={() => {
          setSummaryPending(true);
          void refresh();
        }}
        accepted={accepted}
        home={home}
        onAccepted={(index, task) => {
          setAcceptedHere((prev) => (prev.includes(index) ? prev : [...prev, index]));
          setAdded((prev) => [...prev, task]);
        }}
      />

      {movePicker && (
        <ContainerPicker
          allowInbox
          onClose={() => setMovePicker(false)}
          onPick={(c) => {
            setMovePicker(false);
            void (async () => {
              await fetch(`/api/items/${initial.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ containerId: c ? c.id : null }),
              });
              await refresh();
            })();
          }}
        />
      )}
    </div>
  );
}
