"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PlannerWeekDTO } from "@/lib/dto";
import { openMeeting } from "./open-meeting";
import { WeekGrid } from "./week-grid";

const JSON_HEADERS = { "content-type": "application/json" };
const SAVE_ERROR = "Could not save that change";
/** The drag's own type, so a column only accepts a task dragged from another column. */
const TASK_MIME = "text/task-id";

export function WeekView({ week, today, onRefresh }: { week: PlannerWeekDTO; today: string; onRefresh: () => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onChanged() {
      onRefresh();
    }
    window.addEventListener("sb:tasks-changed", onChanged);
    window.addEventListener("sb:plan-changed", onChanged);
    return () => {
      window.removeEventListener("sb:tasks-changed", onChanged);
      window.removeEventListener("sb:plan-changed", onChanged);
    };
  }, [onRefresh]);

  async function send(url: string, method: string, body?: unknown, event = "sb:tasks-changed") {
    const res = await fetch(url, { method, headers: body ? JSON_HEADERS : undefined, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      setError(SAVE_ERROR);
      return;
    }
    setError(null);
    window.dispatchEvent(new Event(event));
  }

  const patch = (id: number, body: Record<string, unknown>) => void send(`/api/tasks/${id}`, "PATCH", body);

  function openMeetingItem(id: number) {
    void (async () => {
      const itemId = await openMeeting(id);
      if (itemId === null) {
        setError("Could not open that meeting");
        return;
      }
      setError(null);
      router.push(`/items/${itemId}`);
    })();
  }

  // Nothing at all in the week, which the grid cannot say for itself: seven empty columns are
  // indistinguishable from seven columns whose contents are below the fold.
  const empty = week.days.every((d) => d.meetings.length === 0 && d.due.length === 0 && d.plan.length === 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="pane p-3 overflow-x-auto overflow-y-hidden">
        <div className="min-w-[760px]">
          <WeekGrid
            days={week.days}
            today={today}
            drift={week.drift}
            workHours={week.workHours}
            taskMime={TASK_MIME}
            onOpenMeeting={openMeetingItem}
            onDropTask={(taskId, date) => patch(taskId, { dueDate: date })}
          />
        </div>
      </div>
      {empty && <p className="text-[13px] text-fg-faint m-0">Nothing booked this week.</p>}
      {error && <p className="text-danger text-[12.5px] m-0">{error}</p>}
    </div>
  );
}
