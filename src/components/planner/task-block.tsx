"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { BlockDTO, PlanTaskDTO } from "@/lib/dto";
import { formatMinutes } from "@/lib/capacity";
import { formatClock } from "../activity/format";
import { blockEnd, isoToMinutes, minutesToIso, snap } from "./block-math";
import { FocusButton } from "../focus/focus-button";

/**
 * What the column is asked to do with one session. The add names the task, because the session
 * does not exist yet; everything else names the session. The answer is the session's own id,
 * or null when nothing was written.
 */
export type BlockAction =
  | { kind: "add"; taskId: number; startsAt: string; minutes: number }
  | { kind: "move"; id: number; startsAt: string }
  | { kind: "resize"; id: number; minutes: number }
  | { kind: "remove"; id: number };

export type BlockResult = Promise<number | null>;

interface Props {
  task: PlanTaskDTO;
  /** The session this block stands for. */
  block: BlockDTO;
  /** Its place among the task's sessions on the day, from 1, and how many there are. */
  index: number;
  count: number;
  date: string;
  /** Pixel geometry from the layout, in minutes from the column's start. */
  top: number;
  height: number;
  col: number;
  cols: number;
  pxPerMin: number;
  /** How many minutes the column covers, so the length question knows where its floor is. */
  columnMinutes: number;
  onPatchTask: (id: number, body: Record<string, unknown>) => Promise<boolean>;
  onBlock: (action: BlockAction) => BlockResult;
  /** Spec §3: a session just dropped for a task nobody estimated asks how long it should be. */
  askLength?: boolean;
  /** Moving from the pointer: the timeline owns the ghost, the block only reports. */
  onDragStart: (e: PointerEvent<HTMLDivElement>) => void;
}

/** Roughly how tall the length question is: two rows of presets, its padding and its offset. */
const PANEL_PX = 76;
const MOVE = 15;
const FINE = 5;
const MIN_LENGTH = 5;
const MAX_LENGTH = 480;
/** The lengths the question offers, the same ones the estimate chip does. */
const PRESETS = [15, 25, 45, 60, 90, 120];

/**
 * One session of a planned task on the timeline: the title, its place among the day's sessions,
 * the hours, a checkbox that finishes the task where it sits. Arrows move the session, Alt and
 * arrows resize it, Backspace takes it off the timeline (the task stays on the plan). Sessions
 * of a done task stay, dimmed and struck through.
 */
export function TaskBlock({ task, block, index, count, date, top, height, col, cols, pxPerMin, columnMinutes, onPatchTask, onBlock, askLength, onDragStart }: Props) {
  const [resizing, setResizing] = useState(false);
  // The question is asked once: Escape, or a length chosen, puts it away for good, whatever
  // the column still believes about the session it just placed.
  const [dismissed, setDismissed] = useState(false);
  const reduce = useReducedMotion();
  const blockRef = useRef<HTMLDivElement | null>(null);
  const firstPreset = useRef<HTMLButtonElement | null>(null);
  // A resize in flight, as the one call that takes its window listeners off again. Held in a
  // ref so a block that goes away mid-drag — the day reloading under it — leaves none behind.
  const detachResize = useRef<(() => void) | null>(null);
  useEffect(() => () => detachResize.current?.(), []);
  // The start the last arrow wrote, until the day comes back holding it. Two presses in a row
  // are faster than the round trip, and the second must count from the first's answer rather
  // than from a prop that has not moved yet. One block, one note: each session moves alone.
  const pending = useRef<number | null>(null);
  // Only the ref: whatever the prop moved to is the truth now, whether it caught up with what
  // was written here or a pointer drag landed first, so the next move counts from it.
  useEffect(() => {
    pending.current = null;
  }, [block.startsAt]);

  const asking = !!askLength && !dismissed;
  // The question opens with the keyboard already in it, so the answer is one key away.
  useEffect(() => {
    if (asking) firstPreset.current?.focus();
  }, [asking]);
  // A press anywhere else is an answer of sorts: the question goes away rather than following
  // the pointer around the column. The panel hangs inside the block, so one test covers both.
  useEffect(() => {
    if (!asking) return;
    function onDown(e: MouseEvent) {
      if (blockRef.current?.contains(e.target as Node)) return;
      setDismissed(true);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [asking]);
  // Hanging below a block near the foot of the column would put the presets off the end of it,
  // so there the question opens upwards instead.
  const askAbove = (top + height) * pxPerMin + PANEL_PX > columnMinutes * pxPerMin;

  const start = block.startsAt;
  const end = blockEnd(block);
  const done = task.status === "done";
  const over = block.spentMinutes > block.minutes;
  const mark = count > 1 ? ` · ${index} of ${count}` : "";
  const ran = block.spentMinutes > 0 ? `, ran ${formatMinutes(block.spentMinutes)}` : "";
  const name = `${task.title}${mark}, ${formatClock(start)} to ${formatClock(end)}${ran}`;

  async function move(deltaMinutes: number) {
    const from = pending.current ?? isoToMinutes(start);
    const next = Math.max(0, Math.min(24 * 60 - FINE, snap(from + deltaMinutes)));
    const before = pending.current;
    // Noted before the write, so the next press already counts from here; a write that fails
    // never happened, and the ref goes back to what it was.
    pending.current = next;
    if (await onBlock({ kind: "move", id: block.id, startsAt: minutesToIso(date, next) })) {
      window.dispatchEvent(new CustomEvent("sb:toast", { detail: { text: `Moved to ${formatClock(minutesToIso(date, next))}` } }));
    } else {
      pending.current = before;
    }
  }

  async function resize(deltaMinutes: number) {
    const next = Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, block.minutes + deltaMinutes));
    if (next !== block.minutes) await onBlock({ kind: "resize", id: block.id, minutes: next });
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    const step = e.shiftKey ? FINE : MOVE;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const sign = e.key === "ArrowDown" ? 1 : -1;
      if (e.altKey) void resize(sign * FINE);
      else void move(sign * step);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      void onBlock({ kind: "remove", id: block.id });
    }
  }

  /** The question goes away and the keyboard goes back to the session it was asked about. */
  function closeAsk() {
    setDismissed(true);
    blockRef.current?.focus();
  }

  /** Spec §3: the length chosen is the task's estimate and this session's length. The session
   * is only resized once the estimate is saved: a failed write leaves the two as they were,
   * rather than a block of one length against an estimate of another. */
  async function pickLength(minutes: number) {
    closeAsk();
    if (!(await onPatchTask(task.id, { estimateMinutes: minutes }))) return;
    await onBlock({ kind: "resize", id: block.id, minutes });
  }

  // Resizing by pointer: the bottom edge follows the pointer in 5-minute steps and writes the
  // session's length once on release. The element is caught before the handler returns, because
  // React clears `currentTarget` the moment it does.
  function onResizeDown(e: PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget.parentElement as HTMLElement | null;
    const startY = e.clientY;
    const startLen = block.minutes;
    const lengthAt = (y: number) => Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, snap(startLen + (y - startY) / pxPerMin)));

    function detach() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      detachResize.current = null;
    }
    /** Ends the session and puts the layout's own height back, before anything is written: a
     * resize that changes nothing, or that fails, leaves no dragged pixels behind. React
     * believes the node still holds the prop's height, so it has to be written back by hand. */
    function finish() {
      detach();
      if (el) el.style.height = `${height * pxPerMin}px`;
      setResizing(false);
    }
    function onMove(ev: MouseEvent) {
      if (el) el.style.height = `${lengthAt(ev.clientY) * pxPerMin}px`;
    }
    function onUp(ev: MouseEvent) {
      const next = lengthAt(ev.clientY);
      finish();
      if (next !== startLen) void onBlock({ kind: "resize", id: block.id, minutes: next });
    }
    // A cancelled pointer — a touch turning into a scroll, the window losing it — ends the
    // session without writing anything.
    function onCancel() {
      finish();
    }

    detachResize.current = detach;
    setResizing(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  // Everything that names the block and answers to it: the same element either way, so the
  // focus, the keyboard and the pointer never notice which one is rendered.
  const blockProps = {
    ref: blockRef,
    role: "group",
    "aria-label": name,
    tabIndex: 0,
    "data-task-block": task.id,
    "data-block-id": block.id,
    onKeyDown: onKey,
    onPointerDown: done ? undefined : onDragStart,
    // The question hangs below the block, or above it when the column ends too soon, so while it is up the block lets it out and sits over
    // whatever is beside it.
    className: `focus-ring absolute rounded-md border-l-2 border-violet bg-violet-dim select-none ${asking ? "z-50" : "overflow-hidden"} ${done ? "opacity-50" : ""} ${resizing ? "cursor-ns-resize" : "cursor-grab"}`,
    style: {
      top: top * pxPerMin,
      height: height * pxPerMin,
      left: `calc(3.5rem + (100% - 3.5rem) * ${col / cols})`,
      width: `calc((100% - 3.5rem) / ${cols} - 4px)`,
    },
  } as const;

  const inside = (
    <>
      <div className="p-2 flex flex-col gap-0.5 h-full pointer-events-none overflow-hidden">
        <span className="flex items-center gap-2 min-w-0">
          <input
            type="checkbox"
            // Two sessions of one task would otherwise offer two checkboxes of the same name.
            aria-label={`Done: ${task.title}${mark}`}
            checked={done}
            onChange={() => void onPatchTask(task.id, { status: done ? "open" : "done" })}
            onPointerDown={(e) => e.stopPropagation()}
            className="focus-ring accent-violet w-3.5 h-3.5 shrink-0 pointer-events-auto"
          />
          <span className={`truncate text-[13px] ${done ? "line-through text-fg-muted" : ""}`}>{task.title}</span>
          {/* Spec §2: which of the day's sessions this one is, when the task holds more than one. */}
          {count > 1 && <span className="font-mono text-[11px] text-fg-faint shrink-0">{`${index} of ${count}`}</span>}
          {/* Below 30 minutes the time-range row never gets a second row to sit on (the block's
            * own overflow-hidden clips it), so the length rides here instead -- shorter than the
            * full range, but never gone the way it used to. */}
          {height * pxPerMin < 30 && <span className="font-mono text-[10.5px] text-fg-faint shrink-0">{formatMinutes(block.minutes)}</span>}
          {/* Focus lives on the title row, not the row below the time range, because that row
            * is the first thing this block's own overflow-hidden clips away on anything shorter
            * than about 45 minutes -- the one control someone actually presses from here must
            * not be the thing that quietly disappears on a short session. */}
          {!done && (
            <span className="ml-auto shrink-0 pointer-events-auto" onPointerDown={(e) => e.stopPropagation()}>
              <FocusButton task={{ id: task.id, title: task.title }} blockId={block.id} compact />
            </span>
          )}
        </span>
        {height * pxPerMin >= 30 && (
          <span className="font-mono text-[11px] text-fg-faint truncate">
            {formatClock(start)}–{formatClock(end)} · {formatMinutes(block.minutes)}
            {/* What the box actually cost, once something has run against it. A box is a promise
                about time, and a promise nobody ever checks is a wish: this is the only place the
                two numbers sit side by side. Warn rather than danger when it ran over -- the
                figure is there to make the next estimate honest, not to tell anyone off. */}
            {block.spentMinutes > 0 && (
              <span className={over ? "text-warn" : undefined}>{` · ran ${formatMinutes(block.spentMinutes)}`}</span>
            )}
          </span>
        )}
      </div>
      {/* The keyboard resizes with Alt and the arrows on the group itself, so the handle is a
        * pointer affordance only: out of the tab order and out of the accessibility tree. */}
      {!done && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          data-resize={block.id}
          onPointerDown={onResizeDown}
          className="absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize pointer-events-auto"
        />
      )}
      {asking && (
        <div
          role="menu"
          aria-label="Length"
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            closeAsk();
          }}
          className={`panel absolute left-0 rounded-md p-1 grid grid-cols-3 gap-0.5 w-40 ${askAbove ? "bottom-full mb-1" : "top-full mt-1"}`}
        >
          {PRESETS.map((m, i) => (
            <button
              key={m}
              ref={i === 0 ? firstPreset : undefined}
              type="button"
              role="menuitemradio"
              aria-checked={block.minutes === m}
              onClick={() => void pickLength(m)}
              className={`focus-ring font-mono text-[11.5px] h-7 rounded-sm ${block.minutes === m ? "bg-violet-dim text-fg" : "text-fg-muted hover:text-fg hover:bg-layer-2"}`}
            >
              {formatMinutes(m)}
            </button>
          ))}
        </div>
      )}
    </>
  );

  // Spec §7: a block settles into its new top and height over 200 ms, so a move or a resize
  // elsewhere on the column is followed rather than jumped. Reduced motion gets a plain div.
  return reduce ? (
    <div {...blockProps}>{inside}</div>
  ) : (
    <motion.div layout transition={{ duration: 0.2 }} {...blockProps}>
      {inside}
    </motion.div>
  );
}
