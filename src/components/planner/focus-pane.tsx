"use client";

import { useEffect, useState } from "react";
import { Box, Coffee, Play, Square, Timer } from "lucide-react";
import type { FocusMode } from "@/db/enums";
import type { PlanTaskDTO, TaskDTO } from "@/lib/dto";
import { formatMinutes } from "@/lib/capacity";
import { Button, Input } from "../ui";
import { useFocus } from "../focus/use-focus";

/** mm:ss from milliseconds, for a clock that is read at a glance rather than parsed. */
function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * How far through the cycle today is, as one dot per pomodoro up to the long break.
 *
 * The count is the whole point of a cycle and it was invisible: the settings have said
 * `longBreakEvery: 4` since the feature shipped and `break-offer.tsx` has quietly used it to pick
 * the long break, but nothing ever showed how close the next one was. Dots rather than "3 / 4"
 * because this is glanced at, and because a row of four reads as a rhythm where a fraction reads
 * as a score.
 */
function CycleDots({ done, every }: { done: number; every: number }) {
  const position = every > 0 ? done % every : 0;
  // A completed cycle lands on 0; it is a full row, not an empty one.
  const filled = done > 0 && position === 0 ? every : position;
  return (
    <span className="flex items-center gap-1" role="img" aria-label={`${filled} of ${every} before a long break`}>
      {Array.from({ length: every }, (_, i) => (
        <span
          key={i}
          className={`w-1.5 h-1.5 rounded-full ${i < filled ? "bg-violet-bright" : "bg-hairline"}`}
          aria-hidden
        />
      ))}
    </span>
  );
}

/**
 * The lengths a box comes in. Not the pomodoro's one saved default, because choosing the length
 * from the work rather than from a rhythm is the whole difference between the two methods — and
 * not a free number field either, which turns a decision taken in two seconds into typing.
 */
const BOXES = [15, 25, 45, 60, 90];

/** Pomodoro or timebox, as two words rather than a toggle nobody can read the state of. */
function RhythmSwitch({ mode, onPick, disabled }: { mode: FocusMode; onPick: (mode: FocusMode) => void; disabled: boolean }) {
  return (
    <span className="flex items-center gap-0.5 rounded-md bg-layer-2 p-0.5" role="group" aria-label="Rhythm">
      {(["pomodoro", "timebox"] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          disabled={disabled}
          onClick={() => onPick(m)}
          className={`focus-ring rounded-[5px] px-1.5 h-5 text-[11px] capitalize ${mode === m ? "bg-violet-dim text-fg" : "text-fg-faint hover:text-fg"}`}
        >
          {m}
        </button>
      ))}
    </span>
  );
}

/**
 * The focus timer as its own pane, rather than a control hidden on whichever task row happens to
 * be on screen, and in either of the two rhythms the planner keeps.
 *
 * **Pomodoro** is a fixed length with a break after it and a cycle behind it: the length is the
 * saved default, and the end of a run offers the break the cycle calls for.
 *
 * **Timebox** chooses the length from the work instead -- this long, on this, then stop -- and
 * ends in a decision rather than a break (`BoxVerdict`). The hard stop is the point: a box that
 * runs until the work is finished is not a box, it is an open-ended session with a number on it.
 *
 * The run itself is the same `focus_runs` row either way, so the history, the drift figure and
 * the spent minutes read both rhythms as one thing: time that went on this task. Only what is
 * offered before a run and asked after it differs, which is why the rhythm is a saved setting
 * (`focus.mode`) rather than a tab -- it is how someone works, and it should still be chosen
 * tomorrow.
 *
 * A box that has a slot of its own needs nothing from this pane: every session on the timeline
 * already carries a focus button that runs for exactly that session's length.
 */
export function FocusPane({ nextTask }: { nextTask: PlanTaskDTO | null }) {
  const { run, settings, completedToday, remainingMs, breakState, start, finish, takeBreak, endBreak, setMode, busy, error } = useFocus();
  const timebox = settings.mode === "timebox";
  // The box length chosen since the pane was opened; until then the saved default, so the two
  // rhythms start from the same number and only the timebox lets it move.
  const [picked, setPicked] = useState<number | null>(null);
  const boxMinutes = picked ?? settings.defaultMinutes;
  // Whichever rhythm is in force decides how long a start runs for: the pomodoro's saved default,
  // or the box in hand. One place, so no button can disagree with the chips above it.
  const minutes = timebox ? boxMinutes : settings.defaultMinutes;
  // The open tasks, fetched only once somebody asks to choose one -- the pane costs no request
  // until then, and most starts are the planned next thing or nothing at all.
  const [choosing, setChoosing] = useState(false);
  const [tasks, setTasks] = useState<TaskDTO[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!choosing || tasks !== null) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/tasks?status=open", { cache: "no-store" }).catch(() => null);
      if (!res?.ok || cancelled) return;
      const body = (await res.json()) as TaskDTO[] | { tasks: TaskDTO[] };
      if (!cancelled) setTasks(Array.isArray(body) ? body : body.tasks);
    })();
    return () => {
      cancelled = true;
    };
  }, [choosing, tasks]);

  const needle = query.trim().toLowerCase();
  const matches = (tasks ?? []).filter((t) => !needle || t.title.toLowerCase().includes(needle)).slice(0, 6);

  const onBreak = breakState.endsAt !== null;
  const isLong = onBreak && breakState.minutes >= settings.longBreak;

  /** What the pane is called while idle: the rhythm's own name, so the header and the switch
   * below it never read as two different things. */
  const idleLabel = timebox ? "Timebox" : "Pomodoro";

  return (
    <section className="pane p-3 flex flex-col gap-2" aria-label="Focus">
      <header className="flex items-center gap-2">
        {onBreak ? (
          <Coffee className="w-4 h-4 text-fg-muted shrink-0" aria-hidden />
        ) : timebox ? (
          <Box className="w-4 h-4 text-fg-muted shrink-0" aria-hidden />
        ) : (
          <Timer className="w-4 h-4 text-fg-muted shrink-0" aria-hidden />
        )}
        <span className="text-[12.5px]">{onBreak ? (isLong ? "Long break" : "Short break") : run ? "Focusing" : idleLabel}</span>
        <span className="flex-1" />
        {/* The cycle belongs to the pomodoro: a box has no fourth-and-then-a-long-break about it. */}
        {!timebox && <CycleDots done={completedToday} every={settings.longBreakEvery} />}
        <RhythmSwitch mode={settings.mode} onPick={(m) => void setMode(m)} disabled={busy || run !== null || onBreak} />
      </header>

      {/* How long the box is, chosen before it starts and never while one is running: a box whose
          length moves under it is not a commitment. */}
      {timebox && !run && !onBreak && (
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Box length">
          {BOXES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={m === boxMinutes}
              disabled={busy}
              onClick={() => setPicked(m)}
              className={`focus-ring font-mono text-[11.5px] h-6 px-2 rounded-sm ${m === boxMinutes ? "bg-violet-dim text-fg" : "text-fg-muted hover:text-fg hover:bg-layer-2"}`}
            >
              {formatMinutes(m)}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        {/* One clock, whichever phase is running: tabular so the digits do not shuffle each second. */}
        {(run || onBreak) && (
          <span className="font-mono tabular-nums text-[22px] leading-none" aria-live="off">
            {clock(onBreak ? breakState.remainingMs : remainingMs)}
          </span>
        )}

        {run ? (
          <>
            <span className="flex-1 min-w-[10ch] text-[12.5px] text-fg-muted truncate" title={run.taskTitle}>
              {run.taskTitle}
            </span>
            {/* "stopped", not "completed": `closeRow` books a completed run its *planned* minutes,
                so stopping a 45-minute box after six used to charge the task the full 45. Every
                other Stop in the app (the dock chip, Home, `⌘⇧F`, the block's own button) already
                said "stopped"; this one was the odd one out, and it fed the spent figures the
                timebox now shows. */}
            <Button size="sm" variant="ghost" icon={Square} disabled={busy} onClick={() => void finish("stopped")}>
              Stop
            </Button>
          </>
        ) : onBreak ? (
          <>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" icon={Play} disabled={busy} onClick={() => void endBreak()}>
              Back to work
            </Button>
          </>
        ) : (
          <>
            {/* Three ways to start, because neither rhythm is always about something already
                written down. The planned next thing is one press; any other task is one more; and
                a run on nothing at all is its own button rather than a thing you have to fake a
                task for. */}
            {nextTask && (
              <Button size="sm" variant="primary" icon={Play} disabled={busy} onClick={() => void start({ taskId: nextTask.id, minutes })}>
                {`${formatMinutes(minutes)} on ${nextTask.title}`}
              </Button>
            )}
            <Button size="sm" variant={nextTask ? "ghost" : "primary"} icon={Play} disabled={busy} onClick={() => setChoosing((v) => !v)}>
              {nextTask ? "On\u2026" : `${formatMinutes(minutes)} on\u2026`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={Play}
              disabled={busy}
              onClick={() => void start({ minutes })}
              title={
                timebox
                  ? "A box on nothing in particular. It is still focused time against the day, but there is nothing to decide about at the end of it."
                  : "A pomodoro on nothing in particular. It counts towards the day and the cycle, but is not attributed to any work."
              }
            >
              {`Just ${formatMinutes(minutes)}`}
            </Button>
            {/* A box has no break after it — it has a decision. Breaks belong to the cycle. */}
            {!timebox && (
              <Button size="sm" variant="ghost" icon={Coffee} disabled={busy} onClick={() => void takeBreak()}>
                Break
              </Button>
            )}
          </>
        )}
      </div>

      {choosing && !run && !onBreak && (
        <div className="flex flex-col gap-1 border-t border-hairline pt-2">
          <Input
            autoFocus
            size="sm"
            aria-label="Find a task to focus on"
            placeholder="Which task?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setChoosing(false);
            }}
          />
          {tasks === null ? (
            <span className="text-[12px] text-fg-faint">Looking…</span>
          ) : matches.length === 0 ? (
            <span className="text-[12px] text-fg-faint">{needle ? "Nothing matches that" : `No open tasks — \u201cJust ${formatMinutes(minutes)}\u201d starts one anyway`}</span>
          ) : (
            <ul role="list" className="list-none m-0 p-0 flex flex-col">
              {matches.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="focus-ring rounded-sm w-full text-left px-1 py-1 text-[12.5px] truncate hover:bg-layer-2"
                    onClick={() => {
                      setChoosing(false);
                      setQuery("");
                      void start({ taskId: t.id, minutes });
                    }}
                  >
                    {t.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="m-0 text-[12.5px] text-danger">{error}</p>}
    </section>
  );
}
