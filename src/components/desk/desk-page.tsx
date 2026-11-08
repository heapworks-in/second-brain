"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Clock, RefreshCw, X } from "lucide-react";
import type { DeskDTO, ProposalDTO } from "@/lib/dto";
import { Button } from "../ui";
import { PRIMARY_LABELS, dismissNote } from "./answers";

/** How long the line offering to take an answer back stays on screen. */
const UNDO_MS = 8000;

interface Answered {
  id: number;
  label: string;
  href?: string;
  undoable: boolean;
}

/**
 * What is behind the card, and nothing more: a count and a dot per waiting proposal.
 *
 * Visible but not workable, deliberately. Knowing six are left is what makes clearing the desk
 * feel finite; being able to pick among the six is what turns a decision queue back into a list
 * you shop in, which is the failure this whole page is shaped against.
 */
function Rail({ position, total }: { position: number; total: number }) {
  return (
    <div className="flex items-center gap-2" role="img" aria-label={`${position} of ${total} on the desk`}>
      <span className="font-mono tabular-nums text-[11.5px] text-fg-faint">
        {position} / {total}
      </span>
      <span className="flex items-center gap-1" aria-hidden>
        {Array.from({ length: Math.min(total, 7) }, (_, i) => (
          <span key={i} className={`w-1.5 h-1.5 rounded-full ${i < position ? "bg-violet-bright" : "bg-hairline"}`} />
        ))}
      </span>
    </div>
  );
}

/**
 * The desk: one decision at a time, with its evidence on it.
 *
 * Not a list of seven. A list lets you take the three easy ones and leave the one that mattered,
 * and a queue you can scan is a queue you can defer. So the top-ranked proposal gets the whole
 * column, answering it brings up the next, and the rail behind it is the only acknowledgement
 * that there are others.
 *
 * Every answer commits at once and leaves an undo line for eight seconds. A confirm step on a
 * queue of seven would cost fourteen decisions instead of seven, and undo is the honest
 * affordance anyway: the commit has happened, and the only question left is whether it stays.
 */
export function DeskPage({ initial }: { initial: DeskDTO }) {
  const router = useRouter();
  const [desk, setDesk] = useState(initial);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Counted here rather than read from the server: it is what this sitting has got through, which
  // is the number worth seeing at the end of it.
  const [done, setDone] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const card: ProposalDTO | undefined = desk.proposals[0];

  const settle = useCallback((next: DeskDTO) => {
    setDesk(next);
    window.dispatchEvent(new Event("sb:desk-changed"));
  }, []);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const answer = useCallback(
    async (decision: "accept" | "snooze" | "dismiss") => {
      if (!card || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/desk/${card.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        });
        const body = (await res.json()) as { label?: string; href?: string; undoable?: boolean; desk?: DeskDTO; error?: string };
        if (!res.ok) {
          setError(body.error ?? "That did not go through");
          return;
        }
        settle(body.desk!);
        setDone((n) => n + 1);
        setAnswered({ id: card.id, label: body.label ?? "Done", href: body.href, undoable: body.undoable ?? false });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setAnswered(null), UNDO_MS);
      } catch {
        setError("That did not go through");
      } finally {
        setBusy(false);
      }
    },
    [card, busy, settle],
  );

  const undo = useCallback(async () => {
    if (!answered) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/desk/${answered.id}`, { method: "DELETE" });
      const body = (await res.json()) as { undone: boolean; desk: DeskDTO };
      settle(body.desk);
      if (body.undone) setDone((n) => Math.max(0, n - 1));
      setAnswered(null);
    } catch {
      setError("Could not take that back");
    } finally {
      setBusy(false);
    }
  }, [answered, settle]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await fetch("/api/desk/refresh", { method: "POST" });
      // The sweep runs in the worker, so the answer is not the new desk: give it a moment and
      // re-read. A refresh that reported nothing new would read as a broken button.
      await new Promise((r) => setTimeout(r, 600));
      const res = await fetch("/api/desk", { cache: "no-store" });
      if (res.ok) settle((await res.json()) as DeskDTO);
    } finally {
      setBusy(false);
    }
  }, [settle]);

  // One key per answer, because they differ per card and `Enter` cannot mean three things.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "u" && answered?.undoable) {
        e.preventDefault();
        void undo();
        return;
      }
      if (!card) return;
      if (e.key === "Enter" || e.key === "1") {
        e.preventDefault();
        void answer("accept");
      } else if (e.key === "." || e.key === "2") {
        e.preventDefault();
        void answer("snooze");
      } else if (e.key === "n" || e.key === "3") {
        e.preventDefault();
        void answer("dismiss");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, answer, undo, answered]);

  // The sitting's own arithmetic: what has been answered since this page opened, plus what is
  // still waiting. Not the server's total — arriving at a desk of six and answering two should
  // read "3 / 6", not "1 / 4".
  const total = done + desk.open;
  const position = Math.min(total, done + 1);

  return (
    <div className="flex flex-col gap-3 max-w-[46rem]">
      <header className="flex items-center gap-3">
        {total > 0 && <Rail position={position} total={total} />}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={RefreshCw} disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
      </header>

      {card ? (
        <section className="pane p-4 flex flex-col gap-3" aria-label="The decision on the desk">
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[15px] font-medium leading-snug">{card.title}</h2>
            <p className="m-0 text-[12.5px] text-fg-muted">{card.detail}</p>
            {dismissNote(card.dismissRate) && <p className="m-0 text-[11.5px] text-fg-faint">{dismissNote(card.dismissRate)}</p>}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="primary" icon={Check} disabled={busy} onClick={() => void answer("accept")}>
              {PRIMARY_LABELS[card.kind]}
            </Button>
            <Button size="sm" variant="ghost" icon={Clock} disabled={busy} onClick={() => void answer("snooze")}>
              Not now
            </Button>
            <Button size="sm" variant="ghost" icon={X} disabled={busy} onClick={() => void answer("dismiss")}>
              Never
            </Button>
            <span className="flex-1" />
            <span className="text-[11px] text-fg-faint font-mono" aria-hidden>
              ⏎ · . · n
            </span>
          </div>
        </section>
      ) : (
        // Two empty states, because they say different things: one is the end of a sitting and
        // carries what it was worth, the other is simply a quiet morning.
        <p className="m-0 text-[13px] text-fg-muted">
          {done > 0 ? `Desk clear — ${done} ${done === 1 ? "decision" : "decisions"} made.` : "Desk clear."}
        </p>
      )}

      {answered && (
        <p className="m-0 flex items-center gap-2 text-[12.5px] text-fg-muted" role="status">
          <span>{answered.label}.</span>
          {answered.undoable && (
            <button type="button" onClick={() => void undo()} disabled={busy} className="focus-ring rounded-sm underline text-fg-faint hover:text-fg">
              Undo
            </button>
          )}
          {answered.href && (
            <button type="button" onClick={() => router.push(answered.href!)} className="focus-ring rounded-sm underline text-fg-faint hover:text-fg">
              Open it
            </button>
          )}
        </p>
      )}

      {error && <p className="m-0 text-[12.5px] text-danger">{error}</p>}
    </div>
  );
}
