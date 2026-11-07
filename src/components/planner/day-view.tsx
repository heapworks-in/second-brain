"use client";

import { useEffect } from "react";
import type { BlockDTO, PlannerDayDTO } from "@/lib/dto";
import { PlanPane } from "./plan-pane";
import { FocusPane } from "./focus-pane";
import { Timeline, type BlockAction, type BlockResult } from "./timeline";

const JSON_HEADERS = { "content-type": "application/json" };
const SAVE_ERROR = "Could not save that change";

/**
 * Two columns from 1100 px: the timeline on the left, the plan on the right. Below that they
 * stack with the plan first: a phone plans, it does not read a timeline. The plan is written
 * first at every width, so tabbing reaches the day's real work before the calendar beside it.
 */
export function DayView({ day, today, onRefresh }: { day: PlannerDayDTO; today: string; onRefresh: () => void }) {
  // ⌘/ goes straight to the field that feeds the plan.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("sb:plan-picker", { detail: { focus: true } }));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** What the timeline's blocks write with; the plan pane reloads the day off the event. */
  async function patchTask(id: number, body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (!res.ok) {
      window.dispatchEvent(new CustomEvent("sb:toast", { detail: { text: SAVE_ERROR } }));
      return false;
    }
    window.dispatchEvent(new Event("sb:tasks-changed"));
    return true;
  }

  /**
   * What the column's sessions are written with. Each action is one call to the block routes;
   * the answer is the session's own id — the one the add was given, so the column can ask how
   * long a session it just placed should be — or null when nothing was written.
   */
  async function onBlock(action: BlockAction): BlockResult {
    const res =
      action.kind === "add"
        ? await fetch("/api/blocks", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ taskId: action.taskId, startsAt: action.startsAt, minutes: action.minutes }),
          })
        : action.kind === "remove"
          ? await fetch(`/api/blocks/${action.id}`, { method: "DELETE" })
          : await fetch(`/api/blocks/${action.id}`, {
              method: "PATCH",
              headers: JSON_HEADERS,
              body: JSON.stringify(action.kind === "move" ? { startsAt: action.startsAt } : { minutes: action.minutes }),
            });
    if (!res.ok) {
      window.dispatchEvent(new CustomEvent("sb:toast", { detail: { text: SAVE_ERROR } }));
      return null;
    }
    window.dispatchEvent(new Event("sb:tasks-changed"));
    if (action.kind !== "add") return action.id;
    // The session is written; only its id is in doubt. A body that cannot be read costs the
    // question a fresh drop would have asked, and nothing else.
    const block = (await res.json().catch(() => null)) as BlockDTO | null;
    return block?.id ?? null;
  }

  return (
    <div className="grid grid-cols-1 min-[1100px]:grid-cols-[1fr_1fr] min-[1400px]:grid-cols-[5fr_4fr] gap-6 items-start">
      {/* Beside the calendar, in the column the plan already owns -- and above it, because this is
          a live clock that gets glanced at, where the plan is read. `nextTask` is the same
          next-unfinished-task PlanPane itself highlights, so the two cannot name different work. */}
      <div className="min-[1100px]:order-2 flex flex-col gap-6">
        <FocusPane nextTask={day.plan.find((t) => t.status !== "done") ?? null} />
        <PlanPane day={day} today={today} onRefresh={onRefresh} />
      </div>
      <div className="min-[1100px]:order-1">
        <Timeline
          date={day.date}
          meetings={day.meetings}
          tasks={day.plan}
          onPatchTask={patchTask}
          onBlock={onBlock}
          workHours={day.capacity.workHours}
        />
      </div>
    </div>
  );
}
