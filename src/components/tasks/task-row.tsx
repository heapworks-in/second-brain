"use client";

import { useEffect, useRef, useState, type DragEvent, type ElementType, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { GripVertical, MoreHorizontal } from "lucide-react";
import type { TaskDTO } from "@/lib/dto";
import type { TaskPriority } from "@/db/enums";
import { daysBetween, deadlineLabel, TONE_CLASS } from "@/lib/deadline";
import { formatMinutes } from "@/lib/capacity";
import { titleCase } from "@/lib/format";
import { blocksOn } from "../planner/block-math";
import { addDaysLocal, formatClock, WEEKDAYS } from "../activity/format";
import { Button, Chip, IconButton, Input } from "../ui";
import { PeoplePicker } from "../people-picker";
import { EstimateChip } from "./estimate-chip";
import { EstimateHint, hasEstimateHint } from "./estimate-hint";
import { FocusButton } from "../focus/focus-button";
import { SpentLine } from "../focus/spent-line";

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatShortDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${WEEKDAY_SHORT[date.getDay()]} ${date.getDate()}`;
}

const PLAN_DAYS = 7;

/** Seven days from `from`, that day first, named "Today" only when it really is today. Hand-rolled
 * names, like the rest of the app: `toLocale*` would follow the machine's locale instead of the
 * one the UI is written in. */
function planDays(from: string, today: string): { date: string; label: string }[] {
  return Array.from({ length: PLAN_DAYS }, (_, i) => {
    const date = addDaysLocal(from, i);
    const [y, m, d] = date.split("-").map(Number);
    return { date, label: `${date === today ? "Today" : WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${d}` };
  });
}

const MENU_ITEM_FOCUSABLE = '[role="menuitem"], [role="menuitemradio"]';

/** Spec §4: the session lengths "Split into" offers, beside "One session". */
const SPLIT_PRESETS = [25, 45, 60, 90];

/** Shared with the plan pane, whose header menu is the same small thing. */
export const MENU_ITEM = "focus-ring w-full flex items-center px-2 h-8 rounded-sm text-left text-[12.5px] text-fg-muted hover:text-fg hover:bg-layer-2 transition-colors duration-100";
const MENU_ITEM_DANGER = "focus-ring w-full flex items-center px-2 h-8 rounded-sm text-left text-[12.5px] text-danger hover:bg-danger/10 transition-colors duration-100";

interface Props {
  task: TaskDTO;
  today: string;
  onToggle: () => void;
  onRename: (title: string) => void;
  onDue: (value: string | null) => void;
  /** Shows the estimate chip. Left out where an estimate cannot be saved. */
  onEstimate?: (minutes: number | null) => void;
  /** Names who is waiting on the task, or clears it with null. Given, the row offers "Waiting
   * for…" in its menu; the chip itself shows wherever the task carries a requester, because a
   * person waiting is worth seeing on a screen that cannot change it. */
  onRequester?: (personId: number | null) => void;
  onPriority: (priority: TaskPriority) => void;
  onDrop: () => void;
  onDelete: () => void;
  onMove?: (dir: "up" | "down") => void;
  /** Puts the task on a plan, or takes it off again when `planned`. The caller decides which. */
  onPlan?: () => void;
  /** Gives the task a block starting now. Only offered where "now" falls on the day in hand. */
  onBlockNow?: () => void;
  /** Takes every one of the day's sessions off the timeline; the task stays on the plan. */
  onUnblock?: () => void;
  /** Lays the task's sessions in the day's free slots. Offered where a day can be placed into,
   * which is the plan pane; `f` on the row does the same. */
  onPlace?: () => void;
  /** How long each session should be, or null for the whole estimate in one. */
  onSplit?: (minutes: number | null) => void;
  /** The day this row belongs to. A block on it gets a chip that goes and looks at it; a block
   * on any other day is only told, because no timeline on this screen holds it. */
  blockDate?: string;
  /** Offered instead of `onPlan` when the day is the caller's to choose. */
  onPlanDate?: (date: string) => void;
  /** The first of the seven days the "Plan for" list offers. Defaults to today. */
  planFrom?: string;
  /** What the single plan item is called, for a view whose day is not today. */
  planLabel?: string;
  planned?: boolean;
  /** The week column's row: stacked, two-line title, no grip or priority chip. */
  compact?: boolean;
  /** Extra classes for the row itself, e.g. dimming one that is already on a plan. */
  className?: string;
  draggable?: boolean;
  /** Moves the row by `delta` within its list. Given, the row takes Alt+Arrow keys for it --
   *  the grip beside it is mouse-only, and reordering a plan is not a mouse-only idea. */
  onMoveBy?: (delta: number) => void;
  onDragStart?: (e: DragEvent<HTMLLIElement>) => void;
  onDragOver?: (e: DragEvent<HTMLLIElement>) => void;
  onDragLeave?: (e: DragEvent<HTMLLIElement>) => void;
  onDragEnd?: (e: DragEvent<HTMLLIElement>) => void;
  onRowDrop?: (e: DragEvent<HTMLLIElement>) => void;
  /** What the row renders as. The plan list hands in `motion.li` for its layout animation. */
  as?: ElementType;
  /** Extra props for that element — motion's `layout`, `initial`, `exit` and the rest. */
  rowProps?: Record<string, unknown>;
}

export function TaskRow({
  task, today, onToggle, onRename, onDue, onEstimate, onRequester, onPriority, onDrop, onDelete, onMove, onPlan, onPlanDate, onBlockNow, onUnblock, onPlace, onSplit, blockDate, planFrom = today,
  planLabel = "Plan for today", planned, compact, className = "", draggable, onMoveBy, onDragStart, onDragOver, onDragLeave, onDragEnd, onRowDrop,
  as, rowProps: extraRowProps,
}: Props) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [dueOpen, setDueOpen] = useState(false);
  const [dueDraft, setDueDraft] = useState(task.dueDate ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const planButtonRef = useRef<HTMLButtonElement | null>(null);
  const splitButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuPanelRef = useRef<HTMLDivElement | null>(null);
  const [requesterOpen, setRequesterOpen] = useState(false);
  const done = task.status === "done";
  const due = task.dueDate ? deadlineLabel(task.dueDate, today) : null;

  function closeMenu() {
    setMenuOpen(false);
    setPlanOpen(false);
    setSplitOpen(false);
    menuButtonRef.current?.focus();
  }

  // Positions the portalled menu against its trigger button with floating-ui, same as
  // editor/slash-menu.tsx, and keeps it aligned on scroll/resize while open.
  useEffect(() => {
    if (!menuOpen) return;
    const buttonEl = menuButtonRef.current;
    const menuEl = menuPanelRef.current;
    if (!buttonEl || !menuEl) return;
    return autoUpdate(buttonEl, menuEl, () => {
      void computePosition(buttonEl, menuEl, { placement: "bottom-end", middleware: [offset(4), flip(), shift({ padding: 8 })] }).then(({ x, y }) => {
        setMenuPos({ top: y, left: x });
      });
    });
  }, [menuOpen]);

  // Focuses the first menu item once the portalled panel has mounted.
  useEffect(() => {
    if (!menuOpen) return;
    const panel = menuPanelRef.current;
    const first = panel?.querySelector<HTMLElement>(MENU_ITEM_FOCUSABLE);
    first?.focus();
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // A submenu is a step inside the menu, so Escape backs out of it first.
        if (planOpen) {
          setPlanOpen(false);
          planButtonRef.current?.focus();
          return;
        }
        if (splitOpen) {
          setSplitOpen(false);
          splitButtonRef.current?.focus();
          return;
        }
        closeMenu();
        return;
      }
      if (e.key === "Tab") {
        const panel = menuPanelRef.current;
        if (!panel) return;
        const focusables = Array.from(panel.querySelectorAll<HTMLElement>(MENU_ITEM_FOCUSABLE));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuButtonRef.current?.contains(target)) return;
      if (menuPanelRef.current?.contains(target)) return;
      closeMenu();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [menuOpen, planOpen, splitOpen]);

  function startEditTitle() {
    setTitleDraft(task.title);
    setEditingTitle(true);
  }

  function commitTitle() {
    const value = titleDraft.trim();
    setEditingTitle(false);
    if (value && value !== task.title) onRename(value);
    else setTitleDraft(task.title);
  }

  function commitDue(value: string) {
    const next = value || null;
    if (next !== task.dueDate) onDue(next);
  }

  /**
   * Planning, and saying so. The toast used to hang off the keyboard path alone, so the same
   * action taken from the menu changed nothing visible -- on a surface that does not show the
   * plan, that is indistinguishable from a button that does not work. Both paths come here now.
   */
  function plan() {
    if (onPlan) {
      onPlan();
      window.dispatchEvent(
        new CustomEvent("sb:toast", { detail: { text: planned ? "Taken off the plan" : planLabel === "Plan for today" ? "Planned for today" : "Planned" } }),
      );
    } else if (onPlanDate) {
      planOn(planFrom);
    }
  }

  function planOn(date: string) {
    onPlanDate?.(date);
    window.dispatchEvent(
      new CustomEvent("sb:toast", { detail: { text: date === today ? "Planned for today" : `Planned for ${formatShortDate(date)}` } }),
    );
  }

  /** Plans from the keyboard: today's plan, or the first day the row was told to offer. */
  function planFromKey() {
    plan();
  }

  const checkbox = (
    <input
      type="checkbox"
      className={`focus-ring accent-violet w-4 h-4 shrink-0 ${compact ? "mt-1" : ""}`}
      checked={done}
      aria-label={task.title}
      onChange={onToggle}
    />
  );

  const titleNode = editingTitle ? (
    <Input
      size="sm"
      autoFocus
      value={titleDraft}
      onChange={(e) => setTitleDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitTitle();
        } else if (e.key === "Escape") {
          setTitleDraft(task.title);
          setEditingTitle(false);
        }
      }}
      onBlur={commitTitle}
      className={compact ? "w-full min-w-0" : "flex-1 min-w-0"}
    />
  ) : (
    <button
      type="button"
      data-title
      className={`focus-ring text-left min-w-0 text-[13.5px] ${compact ? "w-full line-clamp-2" : "flex-1 truncate"} ${
        done ? "line-through text-fg-faint" : ""
      }`}
      onClick={startEditTitle}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          startEditTitle();
        }
      }}
    >
      {task.title}
    </button>
  );

  const dueNode = dueOpen ? (
    <Input
      type="date"
      size="sm"
      autoFocus
      value={dueDraft}
      onChange={(e) => {
        setDueDraft(e.target.value);
        commitDue(e.target.value);
      }}
      onBlur={() => {
        commitDue(dueDraft);
        setDueOpen(false);
      }}
      className={`font-mono shrink-0 ${compact ? "w-full min-w-0" : "w-36"}`}
    />
  ) : (
    due && (
      <button
        type="button"
        className={`focus-ring font-mono text-[11px] shrink-0 ${compact ? "self-start" : ""} ${TONE_CLASS[due.tone]}`}
        onClick={() => {
          setDueDraft(task.dueDate ?? "");
          setDueOpen(true);
        }}
      >
        {formatShortDate(task.dueDate!)}
      </button>
    )
  );

  /**
   * Who is waiting, and how long they have been. The number is the point: "Priya" alone is a
   * fact about the task, "Priya · 3d" is a fact about Priya's week, and the second one is what
   * makes this outrank an undated task of my own.
   *
   * Tone climbs with the wait rather than with a deadline, because these mostly have no
   * deadline -- the wait is the deadline. A finished task says nothing: the waiting is over.
   */
  const waited = task.requester && task.askedOn ? daysBetween(task.askedOn, today) : null;
  const waitingNode =
    task.requester && !done ? (
      <span
        className={`font-mono text-[11px] shrink-0 ${compact ? "self-start" : ""} ${waited !== null && waited >= 7 ? "text-danger" : waited !== null && waited >= 3 ? "text-warn" : "text-fg-muted"}`}
        title={waited === null ? `${task.requester.name} is waiting` : `${task.requester.name} has been waiting ${waited} day${waited === 1 ? "" : "s"}`}
      >
        {task.requester.name}
        {waited !== null && waited > 0 ? ` · ${waited}d` : ""}
      </span>
    ) : null;

  // Where the task sits on the timeline. Spec §5: on the row's own day the chip says when the
  // first session starts and, when the day holds more, how many others follow; one press takes
  // the keyboard to that first session. A session on another day has no column here to jump to,
  // so the same mono figure only says which day holds it.
  const dayBlocks = blockDate ? blocksOn(task, blockDate) : [];
  const first = dayBlocks[0];
  const more = dayBlocks.length - 1;
  // Nothing on this day: whatever the task holds elsewhere is worth saying, but not offering.
  // The session still to come is the one worth naming — the sessions are in clock order, so it
  // is the first at or after today — and where they are all behind us the latest one says most.
  const elsewhere = first ? null : ((task.blocks.find((b) => b.startsAt >= today) ?? task.blocks.at(-1))?.startsAt ?? null);
  const hasDayBlock = (blockDate ? dayBlocks.length : task.blocks.length) > 0;
  const blockNode = first ? (
    <button
      type="button"
      aria-label={more > 0 ? `Blocked at ${formatClock(first.startsAt)}, ${dayBlocks.length} sessions` : `Blocked at ${formatClock(first.startsAt)}`}
      onClick={() => window.dispatchEvent(new CustomEvent("sb:timeline-focus", { detail: { taskId: task.id, blockId: first.id } }))}
      className="focus-ring font-mono text-[11px] text-violet-bright rounded-sm px-1 shrink-0"
    >
      {formatClock(first.startsAt)}
      {more > 0 && <span className="text-fg-faint">+{more}</span>}
    </button>
  ) : (
    elsewhere && (
      <span title={`Blocked on ${formatShortDate(elsewhere.slice(0, 10))} at ${formatClock(elsewhere)}`} className="font-mono text-[11px] text-violet-bright px-1 shrink-0">
        {formatClock(elsewhere)}
      </span>
    )
  );

  // The goal the task's project serves, named faintly right after the title: a second one
  // shows as a count rather than a second name, so the row never reads as a list of goals.
  const goalRef = task.goals[0];
  const moreGoals = task.goals.length - 1;
  const goalChip = goalRef && (
    <Chip
      href={`/goals/${goalRef.id}`}
      title={goalRef.title}
      className="text-fg-faint h-5 px-1.5 text-[11px] shrink-0 max-w-[9rem]"
    >
      <span className="truncate">{goalRef.title}</span>
      {moreGoals > 0 && <span className="shrink-0">+{moreGoals}</span>}
    </Chip>
  );

  const actions = (
    <>
      {done ? (
        <Button variant="ghost" size="sm" onClick={onToggle} className="shrink-0">
          Reopen
        </Button>
      ) : (
        <>
          <FocusButton task={{ id: task.id, title: task.title }} />
          <IconButton
            label="Task actions"
            icon={MoreHorizontal}
            className="shrink-0"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              menuButtonRef.current = e.currentTarget;
              setMenuOpen((v) => !v);
            }}
          />
          {menuOpen &&
            createPortal(
              <div
                ref={menuPanelRef}
                role="menu"
                className="panel rounded-md p-1 flex flex-col gap-0.5 w-max min-w-48 z-50"
                style={{ position: "absolute", top: menuPos.top, left: menuPos.left }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    closeMenu();
                    startEditTitle();
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    closeMenu();
                    setDueDraft(task.dueDate ?? "");
                    setDueOpen(true);
                  }}
                >
                  Set due date
                </button>
                {onRequester && (
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      closeMenu();
                      if (task.requester) onRequester(null);
                      else setRequesterOpen(true);
                    }}
                  >
                    {task.requester ? `Nobody is waiting (clear ${task.requester.name})` : "Waiting for…"}
                  </button>
                )}
                {onPlanDate && !planned && (
                  <div className="relative">
                    <button
                      type="button"
                      role="menuitem"
                      ref={planButtonRef}
                      className={MENU_ITEM}
                      aria-haspopup="menu"
                      aria-expanded={planOpen}
                      // One submenu at a time: the other is a sibling of this item, not a way out of it.
                      onClick={() => {
                        setSplitOpen(false);
                        setPlanOpen((v) => !v);
                      }}
                    >
                      Plan for
                    </button>
                    {planOpen && (
                      <div role="menu" aria-label="Plan for" className="panel absolute right-full top-0 mr-1 rounded-md p-1 flex flex-col gap-0.5 w-max min-w-32 z-50">
                        {planDays(planFrom, today).map((day) => (
                          <button
                            key={day.date}
                            type="button"
                            role="menuitem"
                            className={MENU_ITEM}
                            onClick={() => {
                              closeMenu();
                              planOn(day.date);
                            }}
                          >
                            {day.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {onPlan && (!onPlanDate || planned) && (
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      closeMenu();
                      plan();
                    }}
                  >
                    {planned ? "Remove from plan" : planLabel}
                  </button>
                )}
                {onPlace && (
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      closeMenu();
                      onPlace();
                    }}
                  >
                    Place in free slots
                  </button>
                )}
                {onSplit && (
                  <div className="relative">
                    <button
                      type="button"
                      role="menuitem"
                      ref={splitButtonRef}
                      className={MENU_ITEM}
                      aria-haspopup="menu"
                      aria-expanded={splitOpen}
                      onClick={() => {
                        setPlanOpen(false);
                        setSplitOpen((v) => !v);
                      }}
                    >
                      Split into
                    </button>
                    {splitOpen && (
                      <div role="menu" aria-label="Split into" className="panel absolute right-full top-0 mr-1 rounded-md p-1 flex flex-col gap-0.5 w-max min-w-32 z-50">
                        {SPLIT_PRESETS.map((minutes) => (
                          <button
                            key={minutes}
                            type="button"
                            role="menuitemradio"
                            aria-checked={task.sessionMinutes === minutes}
                            className={MENU_ITEM}
                            onClick={() => {
                              closeMenu();
                              onSplit(minutes);
                            }}
                          >
                            {formatMinutes(minutes)}
                          </button>
                        ))}
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={task.sessionMinutes === null}
                          className={MENU_ITEM}
                          onClick={() => {
                            closeMenu();
                            onSplit(null);
                          }}
                        >
                          One session
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {onBlockNow && (
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      closeMenu();
                      onBlockNow();
                    }}
                  >
                    Block now
                  </button>
                )}
                {onUnblock && hasDayBlock && (
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      closeMenu();
                      onUnblock();
                    }}
                  >
                    Take off the timeline
                  </button>
                )}
                <div role="group" aria-label="Priority" className="flex items-center gap-1 px-2 py-1">
                  <span className="text-[11px] text-fg-faint mr-0.5">Priority</span>
                  {(["low", "normal", "high"] as const).map((p) => (
                    <Chip
                      key={p}
                      role="menuitemradio"
                      active={task.priority === p}
                      aria-checked={task.priority === p}
                      onClick={() => {
                        closeMenu();
                        onPriority(p);
                      }}
                    >
                      {titleCase(p)}
                    </Chip>
                  ))}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    closeMenu();
                    onMove?.("up");
                  }}
                >
                  Move up
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    closeMenu();
                    onMove?.("down");
                  }}
                >
                  Move down
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => {
                    closeMenu();
                    onDrop();
                  }}
                >
                  Drop
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM_DANGER}
                  onClick={() => {
                    closeMenu();
                    onDelete();
                  }}
                >
                  Delete
                </button>
              </div>,
              document.body,
            )}
        </>
      )}
    </>
  );

  // `p` plans the task under the cursor, `n` blocks it out now and `f` lays its sessions in
  // the day's free slots, unless something on the row is taking the letter itself.
  function onRowKeyDown(e: ReactKeyboardEvent<HTMLLIElement>) {
    // Alt+Arrow moves the row. Checked before the modifier guard below, which exists to keep the
    // single-letter shortcuts from firing on a chord -- this one *is* a chord.
    if (onMoveBy && e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const target = e.target as HTMLElement | null;
      if (target && e.currentTarget.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        onMoveBy(e.key === "ArrowUp" ? -1 : 1);
        return;
      }
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const plans = e.key === "p" && (!!onPlan || !!onPlanDate);
    // A finished task is not blocked out or placed: the menu has no such item either, being
    // closed to it.
    const blocks = e.key === "n" && !!onBlockNow && !done;
    const places = e.key === "f" && !!onPlace && !done;
    if (!plans && !blocks && !places) return;
    // The actions menu and the estimate popover are portalled to the body: their keys still
    // bubble up this React tree, but they are not the row and must not plan it.
    const target = e.target as HTMLElement | null;
    if (!target || !e.currentTarget.contains(target)) return;
    // Only fields that take a letter keep it: the checkbox is an input that does not.
    if (target.isContentEditable || target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement && target.type !== "checkbox" && target.type !== "radio") return;
    e.preventDefault();
    // The row has claimed the letter: the window's `g p` chord must not read it as a jump too.
    e.stopPropagation();
    if (places) onPlace?.();
    else if (blocks) onBlockNow?.();
    else planFromKey();
  }

  const Row = (as ?? "li") as ElementType;
  // The caller's extras (motion props) go first: the row's own role, data and handlers always win.
  const rowProps = {
    ...extraRowProps,
    role: "listitem" as const,
    "data-task-id": task.id,
    draggable,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDragEnd,
    onDrop: onRowDrop,
    onKeyDown: onRowKeyDown,
  };

  // Whether the outside-view hint has something to offer on this row — computed once, so the
  // spent line and the hint can never disagree about which of them gets to offer the estimate
  // (Concern A: two adjacent buttons writing the same field from two different numbers is a
  // coin-flip presented as advice, and the hint's outside view is the one that should win).
  const showEstimateHint = !!onEstimate && hasEstimateHint(task);
  // What the task actually cost, once a run has landed against it — nothing while one has not.
  // Its own offer to correct the estimate is withheld while the hint below is making a better
  // one; the fact of what was spent still renders either way.
  const spentLine = task.spentMinutes > 0 && (
    <SpentLine taskId={task.id} estimateMinutes={task.estimateMinutes} spentMinutes={task.spentMinutes} offerEstimate={!showEstimateHint} />
  );
  // What finished work like this one actually took, offered only where there is no guess yet
  // and enough of that work to trust one — nothing without a place to save it to, and nothing
  // where `hasEstimateHint` says there is nothing to show, so an ordinary row's layout never
  // shifts to make room for an empty wrapper (the case that breaks silently).
  const estimateHint = showEstimateHint && (
    <EstimateHint status={task.status} estimateMinutes={task.estimateMinutes} likeThisMinutes={task.likeThisMinutes} onEstimate={onEstimate!} />
  );
  const extraLine = spentLine || estimateHint;

  const requesterPicker =
    requesterOpen && onRequester ? (
      <PeoplePicker
        single
        title="Who is waiting on this?"
        selected={task.requester ? [task.requester.id] : []}
        onChange={(ids) => onRequester(ids[0] ?? null)}
        onClose={() => setRequesterOpen(false)}
      />
    ) : null;

  // A column of the week is a seventh of the page: the compact row stacks the due date under
  // a two-line title and drops the grip and the priority chip, so the menu still has its place.
  if (compact) {
    return (
      <Row {...rowProps} className={`hairline-row group flex items-start gap-2 px-2 py-2 min-w-0 hover:bg-layer-2 transition-colors ${className}`}>
        {checkbox}
        <span className="flex-1 min-w-0 flex flex-col gap-0.5">
          {titleNode}
          {goalChip}
          {waitingNode}
          {dueNode}
          {(onEstimate || blockNode) && (
            <span className="flex items-center gap-2">
              {onEstimate && <EstimateChip value={task.estimateMinutes} onChange={onEstimate} compact />}
              {blockNode}
            </span>
          )}
          {spentLine}
          {estimateHint}
        </span>
        {actions}
        {requesterPicker}
      </Row>
    );
  }

  return (
    <Row
      {...rowProps}
      className={`hairline-row group flex flex-col gap-1 px-3 ${extraLine ? "py-2" : "h-11 justify-center"} hover:bg-layer-2 transition-colors ${className}`}
    >
      <div className="flex items-center gap-3">
        {/* Visible on hover and on focus-within, so the keyboard finds it too. The title says
            both ways of using it: the grip was already draggable but nothing said so, and the
            Alt+Arrow path had no affordance at all. */}
        <span
          className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 cursor-grab text-fg-faint transition-opacity"
          aria-hidden
          title={onMoveBy ? "Drag to reorder, or Alt+Up / Alt+Down" : undefined}
        >
          <GripVertical className="w-3.5 h-3.5" />
        </span>
        {checkbox}
        {titleNode}
        {goalChip}
        {task.priority === "high" && (
          <Chip as="span" className="text-warn border-warn/40 shrink-0">
            High
          </Chip>
        )}
        {task.priority === "low" && (
          <Chip as="span" className="text-fg-faint shrink-0">
            Low
          </Chip>
        )}
        {waitingNode}
        {dueNode}
        {onEstimate && <EstimateChip value={task.estimateMinutes} onChange={onEstimate} />}
        {blockNode}
        {actions}
        {requesterPicker}
      </div>
      {extraLine && (
        <div className="pl-9 flex flex-col gap-1">
          {spentLine}
          {estimateHint}
        </div>
      )}
    </Row>
  );
}
