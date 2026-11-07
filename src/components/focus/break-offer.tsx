"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button, IconButton } from "../ui";
import { formatDuration } from "../activity/format";
import { wasBox } from "./focus-store";
import { useFocus, type FocusCompletedDetail } from "./use-focus";

/**
 * Where a line about the run that just ended sits: pinned above the dock rather than the top of
 * the page, because `top-4` sat over `TopBar`'s breadcrumb trail at narrow widths. It follows
 * `toasts.tsx`'s idiom for a transient line near the dock, one row higher than the toast stack —
 * both would otherwise sit at `bottom-24`, and on a phone a centred pill and a right-aligned
 * toast overlap there. The width is capped and the text is allowed to wrap so the line can never
 * push the page sideways at 400px. Shared with `BoxVerdict`, which answers the end of a box the
 * way this answers the end of a pomodoro: the two never show at once, so they share one place.
 */
export const OFFER_SHELL =
  "fixed bottom-36 left-1/2 -translate-x-1/2 z-50 panel rounded-2xl min-h-10 py-1.5 px-4 flex items-center gap-2 text-[12.5px] text-fg-muted m-0 max-w-[calc(100vw-3rem)]";

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Design §4.5, said once: "48m focused — 39m on Code, 6m on github.com." No score, no
 * judgement — just where the machine was. `null` when there is nothing to say. */
export function whereLine(offer: FocusCompletedDetail): string | null {
  if (offer.where.length === 0) return null;
  const total = formatDuration((offer.run.actualMinutes ?? offer.run.plannedMinutes) * 60_000);
  const parts = offer.where.map((w) => `${formatDuration(w.ms)} on ${w.label}`);
  return `${total} focused — ${parts.join(", ")}`;
}

/**
 * One line, offered only right after a *pomodoro* finishes on its own — never a modal, and never
 * shown any other way: `sb:focus-completed` is dispatched from exactly one place, `useFocus`'s
 * own auto- and manual-finish, and only for outcome "completed". Taking the break starts a
 * plain countdown here, on this page alone; nothing records a break anywhere, so leaving the
 * page or dismissing the line loses nothing worth keeping.
 */
export function BreakOffer() {
  const [offer, setOffer] = useState<FocusCompletedDetail | null>(null);
  // The break itself is not state here any more. It lives on the server, so this line and the
  // pomodoro pane read one clock -- and, more to the point, a break survives walking to another
  // page, which it did not when the countdown belonged to this component.
  const { breakState, takeBreak, endBreak } = useFocus();
  const onBreak = breakState.endsAt !== null;

  // Read inside the listener below, which is registered once: without a ref it would close over
  // whatever the break was on first render and never see a later one. Written in an effect
  // rather than during render -- the listener only ever reads it in response to an event, long
  // after paint, so there is nothing to gain from writing it earlier and React forbids it.
  const running = useRef(onBreak);
  useEffect(() => {
    running.current = onBreak;
  }, [onBreak]);

  useEffect(() => {
    function onCompleted(e: Event) {
      const detail = (e as CustomEvent<FocusCompletedDetail>).detail;
      // A box ends in a decision, not a break: `BoxVerdict` answers that run instead, and the two
      // read the same `wasBox` so exactly one of them ever speaks.
      if (wasBox(detail)) return;
      setOffer(detail);
      // Finishing a pomodoro means the time was spent working, so a break still on the clock is
      // over whatever it says -- and this line goes back to offering the new one.
      if (running.current) void endBreak();
    }
    window.addEventListener("sb:focus-completed", onCompleted);
    return () => window.removeEventListener("sb:focus-completed", onCompleted);
  }, [endBreak]);

  // Mounted once in the shell rather than any one page, so it floats free like the dock and the
  // toasts do — a fixed line, not something laid into whatever page happens to be showing. Where
  // it sits is `OFFER_SHELL`'s business, shared with the box verdict.
  const shell = OFFER_SHELL;

  if (onBreak) {
    return (
      <p className={shell}>
        <span>
          Back to it in <span className="font-mono tabular-nums">{clock(breakState.remainingMs)}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            setOffer(null);
            void endBreak();
          }}
          className="focus-ring rounded-sm text-fg-faint hover:text-fg underline"
        >
          Skip
        </button>
      </p>
    );
  }

  // Only the countdown outlives the offer: once a break is taken the offer is retired, and the
  // break above is what there is to show.
  if (!offer) return null;

  const minutes = offer.completedToday > 0 && offer.completedToday % offer.settings.longBreakEvery === 0 ? offer.settings.longBreak : offer.settings.shortBreak;

  const where = whereLine(offer);

  return (
    <p className={shell}>
      <span className="flex flex-col gap-0.5 min-w-0">
        <span>Take {minutes} minutes?</span>
        {where && <span className="text-[11px] text-fg-faint">{where}</span>}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          // Retired here, not when the break ends: otherwise the offer would be waiting again the
          // moment the countdown reached zero.
          setOffer(null);
          void takeBreak(minutes);
        }}
      >
        Take a break
      </Button>
      <IconButton label="Dismiss the break offer" icon={X} onClick={() => setOffer(null)} />
    </p>
  );
}
