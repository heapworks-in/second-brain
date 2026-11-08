import { eq, sql } from "drizzle-orm";
import { dailyPlanEntries, tasks } from "@/db/schema";
import { focusMinutesByTask } from "@/domain/focus";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

/**
 * A task planned on several different days that has never once been started.
 *
 * Planning something a fourth time after three days of not touching it is not a plan, it is a
 * wish being carried forward, and the cost is not the task -- it is that it takes up room in
 * every day it appears in and makes the capacity line lie. The proposal is to stop carrying it:
 * accepting takes it off the plan and leaves the task itself alone, open, where it can be chosen
 * again deliberately rather than by inertia.
 *
 * Zero focus minutes is the condition, not "a bit of" progress: a task someone has actually sat
 * with for ten minutes is a task in progress, and the desk has nothing useful to say about it.
 */
// `now` is unused: how many days a task has been carried is a count of plan rows, not a
// distance from today. It stays in the signature because every generator has the same one.
export const taskStalled: Generator = (db) => {
  const minDays = threshold(db, "desk.stalledPlanDays");
  const rows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      days: sql<number>`count(distinct ${dailyPlanEntries.date})`,
      lastPlanned: sql<string>`max(${dailyPlanEntries.date})`,
    })
    .from(tasks)
    .innerJoin(dailyPlanEntries, eq(dailyPlanEntries.taskId, tasks.id))
    .where(eq(tasks.status, "open"))
    .groupBy(tasks.id)
    .having(sql`count(distinct ${dailyPlanEntries.date}) >= ${minDays}`)
    .all();
  if (rows.length === 0) return [];

  const spentByTask = focusMinutesByTask(
    db,
    rows.map((r) => r.id),
  );

  return rows.flatMap((row) => {
    if ((spentByTask.get(row.id) ?? 0) > 0) return [];
    const days = Number(row.days);
    return [
      {
        kind: "task_stalled" as const,
        source: "task" as const,
        sourceRef: `task:${row.id}`,
        title: row.title,
        detail: `Planned on ${days} different days, never started. Last on ${row.lastPlanned}.`,
        payload: { taskId: row.id, days, lastPlanned: row.lastPlanned },
        // Each further day of carrying it is more evidence, saturating at twice the threshold.
        urgency: Math.min(1, (days - minDays) / minDays + 0.3),
      },
    ];
  });
};
