"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { BlockDTO } from "@/lib/dto";
import { formatMinutes } from "@/lib/capacity";
import { Button, IconButton } from "../ui";
import { formatClock, todayLocal } from "../activity/format";
import { OFFER_SHELL, whereLine } from "./break-offer";
import { wasBox } from "./focus-store";
import type { FocusCompletedDetail } from "./use-focus";

const JSON_HEADERS = { "content-type": "application/json" };

function toast(text: string): void {
  window.dispatchEvent(new CustomEvent("sb:toast", { detail: { text } }));
}

/**
 * What a timebox ends in: a decision, where a pomodoro ends in a break.
 *
 * The box is the commitment — this long, on this, and then stop. So the moment it runs out is the
 * moment worth asking about, and the question is the whole method: did that land? The three
 * answers are the only three there are. Done closes the task. Another box says the work needs
 * more time and books it, rather than letting the box quietly become "until I finish", which is
 * the failure mode timeboxing exists to prevent. Leaving it is a real answer too — the run is
 * already recorded either way, and a box that ended with the work parked is not a box that failed.
 *
 * Mounted beside `BreakOffer` in the app shell, and the two read the same `wasBox`, so exactly one
 * of them ever answers a given run.
 */
export function BoxVerdict() {
  const [offer, setOffer] = useState<FocusCompletedDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onCompleted(e: Event) {
      const detail = (e as CustomEvent<FocusCompletedDetail>).detail;
      // A box on nothing in particular has nothing to decide: there is no task to close and no
      // work to book another box for. The clock reaching zero is the whole of its ending.
      if (!wasBox(detail) || detail.run.taskId === null) return;
      setOffer(detail);
      setBusy(false);
    }
    window.addEventListener("sb:focus-completed", onCompleted);
    return () => window.removeEventListener("sb:focus-completed", onCompleted);
  }, []);

  if (!offer) return null;
  const { run } = offer;
  const taskId = run.taskId;
  if (taskId === null) return null;
  const minutes = run.plannedMinutes;
  const where = whereLine(offer);

  async function markDone() {
    setBusy(true);
    const res = await fetch(`/api/tasks/${taskId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ status: "done" }) }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      toast("Could not close that task");
      return;
    }
    setOffer(null);
    window.dispatchEvent(new Event("sb:tasks-changed"));
    toast(`Done: ${run.taskTitle}`);
  }

  /** Another box of the same length, in the first free time left today. The day decides when —
   * asking the person to choose a slot at the end of a box is the moment they are least able to. */
  async function anotherBox() {
    setBusy(true);
    const res = await fetch("/api/blocks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ taskId, minutes, date: todayLocal(), at: "next-free" }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (BlockDTO & { error?: string }) | null;
    setBusy(false);
    if (!res?.ok) {
      // The day being full is a real answer, not a failure: it is said in the words the domain
      // used ("No 45 free minutes left that day") rather than a generic save error.
      toast(body?.error ?? "Could not add another box");
      return;
    }
    setOffer(null);
    window.dispatchEvent(new Event("sb:tasks-changed"));
    if (body) toast(`Another ${formatMinutes(minutes)} at ${formatClock(body.startsAt)}`);
  }

  return (
    <p className={OFFER_SHELL} role="status">
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="truncate text-fg">{`${formatMinutes(minutes)} on ${run.taskTitle} is up.`}</span>
        {where && <span className="text-[11px] text-fg-faint">{where}</span>}
      </span>
      <Button size="sm" variant="primary" disabled={busy} onClick={() => void markDone()}>
        Done
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void anotherBox()}>
        {`Another ${formatMinutes(minutes)}`}
      </Button>
      <IconButton label="Leave it for now" icon={X} onClick={() => setOffer(null)} />
    </p>
  );
}
