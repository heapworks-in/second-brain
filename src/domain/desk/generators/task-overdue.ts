import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { containers, dailyPlanEntries, tasks } from "@/db/schema";
import { addDays, localDay } from "@/domain/activity";
import { MINE } from "@/domain/tasks";
import { daysBetween } from "@/lib/deadline";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

/**
 * A task whose own due date has been and gone, with nothing set aside for it today.
 *
 * The one piece of evidence on the desk that the person themselves put there. Every other kind
 * here is inferred -- an estimate overrun, a capture with no home, a plan carried forward -- but a
 * due date was typed deliberately on a day when the work mattered enough to date it. A date that
 * passes in silence is therefore the cheapest signal available and the most damning: sixty-five
 * tasks, none ever completed and eight already past due, with no surface anywhere that noticed.
 *
 * The urgency *grows*, like `commitment_owed` and unlike `commitment_unbooked`. A dropped
 * intention goes stale and stops mattering; a missed date does not heal, because whatever the date
 * was for has already happened without the work being done.
 *
 * Already on today's plan is the exception, not "not finished". Having chosen to do it today is
 * the answer this card asks for, and showing it anyway would teach the ranker that the kind is
 * unwanted when it was only late to notice.
 */
export const taskOverdue: Generator = (db, now) => {
  const graceDays = threshold(db, "desk.overdueGraceDays");
  const today = localDay(now.toISOString());
  const rows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      dueDate: tasks.dueDate,
      containerId: tasks.containerId,
      containerName: containers.name,
    })
    .from(tasks)
    .leftJoin(containers, eq(containers.id, tasks.containerId))
    // A left join and a null check, rather than NOT IN: the planned-for-today rows are the ones
    // being excluded, and an anti-join says that in one place the query planner understands.
    .leftJoin(
      dailyPlanEntries,
      and(eq(dailyPlanEntries.taskId, tasks.id), eq(dailyPlanEntries.date, today)),
    )
    .where(
      and(
        MINE,
        eq(tasks.status, "open"),
        isNull(tasks.completedAt),
        isNull(tasks.droppedAt),
        isNotNull(tasks.dueDate),
        lte(tasks.dueDate, addDays(today, -graceDays)),
        isNull(dailyPlanEntries.id),
      ),
    )
    .all();

  const ago = (days: number) => (days === 1 ? "a day" : `${days} days`);
  // Matching `commitment_owed`'s shape on purpose: a third of the scale on the first qualifying
  // day, all of it at a fortnight, so a date missed last week outranks yesterday's.
  const urgency = (days: number) => Math.min(1, 0.3 + (days - graceDays) / 14);

  // A container is the honest cause: these are late because the thing they belong to has stalled,
  // not because each slipped on its own. Asking seven times what is really one question is what
  // made the desk unanswerable -- and a task with no container has no cause to name, so it never
  // groups.
  const byContainer = new Map<number, typeof rows>();
  const alone: typeof rows = [];
  for (const row of rows) {
    if (row.containerId === null) {
      alone.push(row);
      continue;
    }
    const group = byContainer.get(row.containerId);
    if (group) group.push(row);
    else byContainer.set(row.containerId, [row]);
  }
  for (const [id, group] of byContainer) {
    if (group.length === 1) {
      alone.push(group[0]);
      byContainer.delete(id);
    }
  }

  const singles = alone.map((row) => {
    const days = daysBetween(row.dueDate!, today);
    return {
      kind: "task_overdue" as const,
      source: "task" as const,
      sourceRef: `task:${row.id}`,
      title: row.title,
      detail: `Due ${row.dueDate}, ${ago(days)} ago. Nothing set aside for it today.`,
      payload: { taskId: row.id, dueDate: row.dueDate, days, containerId: row.containerId },
      urgency: urgency(days),
    };
  });

  const grouped = [...byContainer.entries()].map(([containerId, group]) => {
    // The group is as urgent as its worst member, and names that one's date: an average would
    // make a three-week-old miss look like a mild one because four recent tasks sit beside it.
    const oldest = group.reduce((a, b) => (a.dueDate! <= b.dueDate! ? a : b));
    const days = daysBetween(oldest.dueDate!, today);
    const where = group[0].containerName ?? "one project";
    return {
      kind: "task_overdue" as const,
      source: "task" as const,
      // Keyed on the container, not its members, so the group keeps its identity across sweeps --
      // and so dismissing it stays dismissed when one more task in it goes past due.
      sourceRef: `container:${containerId}:overdue`,
      title: `${group.length} tasks in ${where} are overdue`,
      detail: `Oldest due ${oldest.dueDate}, ${ago(days)} ago. Nothing set aside for any of them today.`,
      payload: {
        taskIds: group.map((r) => r.id),
        containerId,
        count: group.length,
        days,
        dueDate: oldest.dueDate,
      },
      count: group.length,
      urgency: urgency(days),
    };
  });

  return [...grouped, ...singles];
};
