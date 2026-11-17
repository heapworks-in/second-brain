"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Check, Clock, RefreshCw, X } from "lucide-react";
import type { DeskDTO, ProposalDTO } from "@/lib/dto";
import { Button } from "../ui";
import { PRIMARY_LABELS, dismissNote, groupIntoSections } from "./answers";

/** An origin that is not a path into this app -- a Slack permalink, a deep link into another app. */
function external(href: string): boolean {
  return !href.startsWith("/");
}

/** Let macOS route it: `slack://` reaches the installed Slack, `https://` the default browser. */
async function openOutside(href: string): Promise<void> {
  await fetch("/api/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: href }),
  });
}

/** How long the line offering to take an answer back stays on screen. */
const UNDO_MS = 8000;

interface Answered {
  id: number;
  label: string;
  href?: string;
  undoable: boolean;
}

/**
 * The desk: everything open, grouped by the kind of attention it needs, each row carrying what it
 * is about and where to go and look at it.
 *
 * This replaces one-card-at-a-time, which was argued for on the grounds that "a queue you can scan
 * is a queue you can defer" and lost on the evidence: across 810 sweeps nothing was ever decided.
 * Hiding nine of ten things gives you no reason to open the page, and a page you do not open
 * cannot be answered. Seeing the whole picture is what makes it worth opening; the sections and
 * the grouped rows are what keep it short enough to read.
 *
 * Tabs were the obvious alternative and were rejected for the same reason the board exists: a tab
 * is a thing you do not look at.
 *
 * The fast path survives. j and k move, Enter, . and N answer the focused row, so the list can be
 * worked top to bottom without touching the mouse -- which is what one-at-a-time was really
 * protecting, and it never needed the hiding to do it.
 */
export function DeskPage({ initial }: { initial: DeskDTO }) {
  const router = useRouter();
  const [desk, setDesk] = useState(initial);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  // Counted here rather than read from the server: it is what this sitting has got through, which
  // is the number worth seeing at the end of it.
  const [done, setDone] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sections = useMemo(() => groupIntoSections(desk.proposals), [desk.proposals]);
  /** The rows in the order they are drawn, so j and k walk the page rather than the raw ranking. */
  const ordered = useMemo(() => sections.flatMap((s) => s.cards), [sections]);
  const focusedCard: ProposalDTO | undefined = ordered[Math.min(focused, ordered.length - 1)];

  const settle = useCallback((next: DeskDTO) => {
    setDesk(next);
    window.dispatchEvent(new Event("sb:desk-changed"));
  }, []);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const answer = useCallback(
    async (card: ProposalDTO | undefined, decision: "accept" | "snooze" | "dismiss") => {
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
    [busy, settle],
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
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setFocused((i) => Math.min(i + 1, ordered.length - 1));
        return;
      }
      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocused((i) => Math.max(i - 1, 0));
        return;
      }
      if (!focusedCard) return;
      // One key per answer, because they differ per row and Enter cannot mean three things.
      if (e.key === "Enter" || e.key === "1") {
        e.preventDefault();
        void answer(focusedCard, "accept");
      } else if (e.key === "." || e.key === "2") {
        e.preventDefault();
        void answer(focusedCard, "snooze");
      } else if (e.key === "n" || e.key === "3") {
        e.preventDefault();
        void answer(focusedCard, "dismiss");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedCard, ordered.length, answer, undo, answered]);

  const hidden = desk.open - desk.proposals.length;

  return (
    <div className="flex flex-col gap-5 w-full max-w-[52rem] mx-auto px-1 pt-2 sm:pt-5">
      <header className="flex items-center gap-3">
        <span className="font-mono tabular-nums text-[11.5px] text-fg-faint">
          {desk.open} {desk.open === 1 ? "decision" : "decisions"}
          {done > 0 && ` · ${done} answered`}
        </span>
        <span className="flex-1" />
        {/* The keys were `⏎ · . · n`, in which the snooze key IS a period and the separators were
            middle dots -- the same character doing two jobs, at 11px in the faintest grey. */}
        <span className="hidden sm:flex items-center gap-1.5 text-[11px] text-fg-faint" aria-hidden>
          {[
            { key: "j", what: "move" },
            { key: "Enter", what: "yes" },
            { key: ".", what: "later" },
            { key: "N", what: "never" },
          ].map(({ key, what }) => (
            <span key={key} className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 rounded border border-hairline bg-layer-2 font-mono text-[10.5px] text-fg-muted">{key}</kbd>
              {what}
            </span>
          ))}
        </span>
        <Button size="sm" variant="ghost" icon={RefreshCw} disabled={busy} onClick={() => void refresh()}>
          Refresh
        </Button>
      </header>

      {ordered.length === 0 ? (
        // Two empty states, because they say different things: one is the end of a sitting and
        // carries what it was worth, the other is simply a quiet morning.
        <p className="m-0 text-[13px] text-fg-muted">
          {done > 0 ? `Desk clear — ${done} ${done === 1 ? "decision" : "decisions"} made.` : "Desk clear."}
        </p>
      ) : (
        sections.map((section) => (
          <section key={section.id} className="flex flex-col gap-2" aria-label={section.title}>
            <div className="flex items-baseline gap-2">
              <h2 className="m-0 micro">{section.title}</h2>
              <span className="font-mono tabular-nums text-[11px] text-fg-faint">{section.cards.length}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {section.cards.map((card) => (
                <Row
                  key={card.id}
                  card={card}
                  busy={busy}
                  focused={focusedCard?.id === card.id}
                  onFocus={() => setFocused(ordered.findIndex((c) => c.id === card.id))}
                  onAnswer={(decision) => void answer(card, decision)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {hidden > 0 && <p className="m-0 text-[12px] text-fg-faint">{hidden} more waiting, held back so this page stays readable.</p>}

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

/**
 * One decision, with its evidence and its source on it.
 *
 * The source is the part the single card never had. A sentence you cannot check is one you either
 * take on trust or ignore, and ignoring is cheaper -- so every row names the thing it is about and
 * links to it wherever there is somewhere to go.
 */
function Row({
  card,
  busy,
  focused,
  onFocus,
  onAnswer,
}: {
  card: ProposalDTO;
  busy: boolean;
  focused: boolean;
  onFocus: () => void;
  onAnswer: (decision: "accept" | "snooze" | "dismiss") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const note = dismissNote(card.dismissRate);

  useEffect(() => {
    // Optional-called: jsdom has no scrollIntoView, and a keyboard nicety must never be the thing
    // that stops the page rendering.
    if (focused) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);

  return (
    <div
      ref={ref}
      onMouseEnter={onFocus}
      className={`pane px-3.5 py-3 flex flex-col gap-2.5 transition-colors ${focused ? "border-violet-bright/40 bg-layer-2" : ""}`}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <h3 className="m-0 text-[14px] font-medium leading-snug text-balance min-w-0">{card.title}</h3>
          {card.count > 1 && (
            <span className="shrink-0 font-mono tabular-nums text-[11px] text-fg-faint" aria-label={`${card.count} items`}>
              ×{card.count}
            </span>
          )}
        </div>
        <p className="m-0 text-[12.5px] text-fg-muted">{card.detail}</p>
        {note && <p className="m-0 text-[11.5px] text-fg-faint">{note}</p>}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="primary" icon={Check} disabled={busy} onClick={() => onAnswer("accept")}>
          {PRIMARY_LABELS[card.kind](card.count)}
        </Button>
        <Button size="sm" variant="ghost" icon={Clock} disabled={busy} onClick={() => onAnswer("snooze")}>
          Not now
        </Button>
        <Button size="sm" variant="ghost" icon={X} disabled={busy} onClick={() => onAnswer("dismiss")}>
          Never
        </Button>
        <span className="flex-1" />
        {card.origin &&
          (card.origin.href ? (
            // A row's origin can be outside the app -- a Slack message lives in Slack. Following
            // one as a link navigates the window showing it, which in the desktop shell is the
            // app's own: clicking a Slack row replaced Second Brain with Slack's web client. An
            // external one is handed to macOS instead, which routes `slack://` to the real app.
            external(card.origin.href) ? (
              <button
                type="button"
                onClick={() => void openOutside(card.origin!.href!)}
                className="focus-ring rounded-sm flex items-center gap-1 text-[11.5px] text-fg-faint hover:text-fg max-w-[14rem]"
              >
                <span className="truncate">{card.origin.label}</span>
                <ArrowUpRight className="w-3 h-3 shrink-0" aria-hidden />
              </button>
            ) : (
              <Link
                href={card.origin.href}
                className="focus-ring rounded-sm flex items-center gap-1 text-[11.5px] text-fg-faint hover:text-fg max-w-[14rem]"
              >
                <span className="truncate">{card.origin.label}</span>
                <ArrowUpRight className="w-3 h-3 shrink-0" aria-hidden />
              </Link>
            )
          ) : (
            <span className="text-[11.5px] text-fg-faint max-w-[14rem] truncate">{card.origin.label}</span>
          ))}
      </div>
    </div>
  );
}
