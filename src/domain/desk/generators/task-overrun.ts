import { and, eq, gt, isNotNull } from "drizzle-orm";
import { tasks } from "@/db/schema";
import { focusMinutesByTask, similarActualMinutes } from "@/domain/focus";
import { formatMinutes } from "@/lib/capacity";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

/** Estimates are read in quarter hours, so a re-estimate is offered in them too. */
export function roundToQuarterHour(minutes: number): number {
  return Math.max(15, Math.round(minutes / 15) * 15);
}

/**
 * A task that has taken half again as long as it was given.
 *
 * The proposal is not "you are late" -- the time is already spent and saying so changes nothing.
 * It is that the *estimate* is now the wrong number, and leaving it wrong is what quietly ruins
 * every capacity line the planner draws for the rest of the week. Accepting re-estimates to what
 * the work has actually taken so far, rounded to the quarter hour the planner reads in.
 *
 * `similarActualMinutes` only ever decorates the card: it needs a container and three comparable
 * finished tasks, so it is absent far more often than present, and a commit that depended on it
 * would be a commit that usually could not happen.
 */
// `now` is unused: an overrun is estimate against minutes spent, and neither is a date.
export const taskOverrun: Generator = (db) => {
  const ratio = threshold(db, "desk.overrunRatio");
  const open = db
    .select({ id: tasks.id, title: tasks.title, estimateMinutes: tasks.estimateMinutes, containerId: tasks.containerId })
    .from(tasks)
    .where(and(eq(tasks.status, "open"), isNotNull(tasks.estimateMinutes), gt(tasks.estimateMinutes, 0)))
    .all();
  if (open.length === 0) return [];

  const spentByTask = focusMinutesByTask(
    db,
    open.map((t) => t.id),
  );

  return open.flatMap((task) => {
    const estimate = task.estimateMinutes!;
    const spent = spentByTask.get(task.id) ?? 0;
    if (spent < estimate * ratio) return [];

    const proposed = roundToQuarterHour(spent);
    const likeThis = similarActualMinutes(db, task);
    const comparison = likeThis !== null ? ` Work like this has taken ${formatMinutes(likeThis)}.` : "";

    return [
      {
        kind: "task_overrun" as const,
        source: "task" as const,
        sourceRef: `task:${task.id}`,
        title: task.title,
        detail: `Estimated ${formatMinutes(estimate)}, ${formatMinutes(spent)} spent so far.${comparison}`,
        payload: { taskId: task.id, estimateMinutes: estimate, spentMinutes: spent, proposedMinutes: proposed },
        // How far past the estimate it is, saturating at three times over: beyond that the
        // estimate is not wrong by a degree, it is simply unrelated to the work.
        urgency: Math.min(1, (spent / estimate - ratio) / (3 - ratio) + 0.2),
      },
    ];
  });
};
