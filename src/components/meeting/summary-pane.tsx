"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, ClipboardCheck, Copy, Plus, Sparkles } from "lucide-react";
import type { TaskDTO } from "@/lib/dto";
import { Button, Input } from "../ui";
import { hasRecapContent, meetingRecap } from "@/domain/meetings/recap";

/** What the summary job writes to `meta.summary`. */
export interface MeetingSummaryMeta {
  summary: string;
  decisions: string[];
  proposed_actions: { title: string; notes?: string }[];
}

/** Where a task made from this meeting lands, in words the row can link to. */
export interface TaskHome {
  label: string;
  href: string;
}

interface Props {
  itemId: number;
  /** Names the meeting in the recap, so what gets pasted says which one it was. */
  title: string;
  summary: MeetingSummaryMeta | undefined;
  summaryError: string | undefined;
  /** Set when a summary was produced from a split transcript but does not cover all of it. */
  summaryGaps: string | undefined;
  /** False when the local summary model isn't installed yet, which is why there may be no summary. */
  hasSummaryModel: boolean;
  /** Indices of the proposed actions already turned into tasks. */
  accepted: number[];
  home: TaskHome;
  onAccepted: (index: number, task: TaskDTO) => void;
  /** True once there is a transcript or notes: nothing to summarise before that. */
  canSummarize: boolean;
  /** Set while a pass is on its way, so the button says so rather than inviting a second one. */
  pending: boolean;
  /** Told a pass is on its way, so the page starts watching for it to land. */
  onQueued: () => void;
}

/**
 * What the model made of the meeting: a paragraph, the decisions, and the actions it thinks
 * somebody now owns. Each action is a row the person can reword before accepting; accepting
 * one creates a task that remembers this meeting.
 */
export function SummaryPane({ itemId, title, summary, summaryError, summaryGaps, hasSummaryModel, accepted, home, onAccepted, canSummarize, pending, onQueued }: Props) {
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  /** The summary is written by a background job, and until now the only thing that could ask for
   *  one was the transcript job finishing -- so a meeting that missed that moment, for any
   *  reason, had no way back. This is that way back. */
  async function summarize() {
    setQueueing(true);
    setQueueError(null);
    try {
      const res = await fetch(`/api/meetings/${itemId}/summarize`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setQueueError(body?.error ?? "Could not start the summary");
        return;
      }
      onQueued();
    } catch {
      setQueueError("Could not start the summary");
    } finally {
      setQueueing(false);
    }
  }

  async function accept(index: number, title: string) {
    setBusy(index);
    setError(null);
    try {
      const res = await fetch(`/api/meetings/${itemId}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ index, title }),
      });
      const body = (await res.json()) as { task?: TaskDTO; error?: string };
      if (!res.ok || !body.task) {
        setError(body.error ?? "Could not add the task");
        return;
      }
      onAccepted(index, body.task);
    } catch {
      setError("Could not add the task");
    } finally {
      setBusy(null);
    }
  }

  const recapInput = { title, summary };
  const recap = hasRecapContent(recapInput) ? meetingRecap(recapInput) : null;

  return (
    <section className="pane" aria-label="Summary">
      <header className="flex items-center gap-2 px-4 h-11 border-b border-hairline">
        <span className="micro">Summary</span>
        {/* The written recap is the point of the summary, not a by-product of it: a meeting whose
            decisions and owners were never confirmed back to the room is the one that goes wrong
            later. One button, already formatted, so sending it is not a separate piece of work. */}
        <span className="flex-1" />
        {recap && (
          <Button
            size="sm"
            icon={copied ? ClipboardCheck : Copy}
            onClick={() => {
              void navigator.clipboard.writeText(recap).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              });
            }}
          >
            {copied ? "Copied" : "Copy recap"}
          </Button>
        )}
        {canSummarize && (
          <Button size="sm" icon={Sparkles} disabled={queueing || pending} onClick={() => void summarize()}>
            {pending ? "Summarising" : summary || summaryError ? "Summarise again" : "Summarise"}
          </Button>
        )}
      </header>

      <div className="px-4 py-4 flex flex-col gap-5">
        {summary ? (
          <p className="text-[13.5px] leading-relaxed">{summary.summary}</p>
        ) : (
          <p className="text-[13px] text-fg-faint">
            {pending
              ? "Writing the summary. It takes a few minutes on this machine"
              : hasSummaryModel
                ? "No summary yet. One is written once the final transcript lands"
                : "Run scripts/brain.sh setup to install the local summary model"}
          </p>
        )}

        {queueError && <p className="text-[12.5px] text-danger">{queueError}</p>}

        {summaryError && <p className="text-[12.5px] text-danger">The summary failed: {summaryError}</p>}

        {/* A summary assembled from parts of a long transcript, where some part could not be read.
            Worth saying plainly: the sections below are true, but they are not the whole meeting. */}
        {summaryGaps && <p className="text-[12.5px] text-warn">This does not cover the whole meeting: {summaryGaps}</p>}

        {summary && summary.decisions.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="micro">Decisions</span>
            <ul role="list" className="list-none m-0 p-0 flex flex-col gap-1">
              {summary.decisions.map((d, i) => (
                <li key={`${i}-${d}`} className="flex gap-2 items-baseline text-[13.5px] leading-relaxed">
                  <span className="text-fg-faint shrink-0" aria-hidden>
                    —
                  </span>
                  <span>{d}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {summary && summary.proposed_actions.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="micro">Proposed actions</span>
            {error && <p className="text-[12.5px] text-danger">{error}</p>}
            <ul role="list" className="list-none m-0 p-0 flex flex-col">
              {summary.proposed_actions.map((action, index) => {
                const done = accepted.includes(index);
                const title = titles[index] ?? action.title;
                return (
                  <li key={`${index}-${action.title}`} className="hairline-row flex items-center gap-2 py-2 flex-wrap">
                    {done ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-success shrink-0" aria-hidden />
                        <span className="flex-1 min-w-[12ch] text-[13.5px] truncate">{title}</span>
                        <span className="text-[12px] text-fg-muted">Added</span>
                        <Link href={home.href} className="focus-ring rounded-sm text-[12px] text-violet-bright underline underline-offset-[3px]">
                          {home.label}
                        </Link>
                      </>
                    ) : (
                      <>
                        <Input
                          size="sm"
                          aria-label={`Task title for ${action.title}`}
                          value={title}
                          onChange={(e) => setTitles((t) => ({ ...t, [index]: e.target.value }))}
                          className="flex-1 min-w-[12ch]"
                        />
                        <Button
                          size="sm"
                          icon={Plus}
                          disabled={busy === index || !title.trim()}
                          onClick={() => void accept(index, title.trim())}
                        >
                          Add as task
                        </Button>
                      </>
                    )}
                    {action.notes && <span className="basis-full text-[12px] text-fg-faint">{action.notes}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
