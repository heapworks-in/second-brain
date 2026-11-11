import { and, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { people, taskBlocks, tasks } from "@/db/schema";
import { addDays, localDay } from "@/domain/activity";
import { MINE } from "@/domain/tasks";
import { daysBetween } from "@/lib/deadline";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

/**
 * Something somebody else is waiting on, that has been waiting a while, and that has no time
 * set aside for it.
 *
 * This is the only kind here whose cost lands on a week that is not mine. A task of my own that
 * slips costs me a day; a ten-minute unblock that sits for three days costs somebody else three
 * days of not starting, and they have no way of knowing whether it is coming. That asymmetry is
 * the whole argument for the weight it carries.
 *
 * The urgency *grows* with the wait, which is the exact opposite of `commitment_unbooked` and
 * deliberate: a commitment I dropped goes stale and eventually stops mattering, but a person
 * waiting on me only gets more stuck. It reaches the top of the scale at a fortnight, which is
 * about where a favour stops being a favour and becomes a thing they tell other people about.
 *
 * No session on the timeline is the condition, not "not finished". A task I have already given
 * time to today is a task in progress, and the honest answer to it is the timeline, not a card.
 */
export const commitmentOwed: Generator = (db, now) => {
  const waitDays = threshold(db, "desk.owedWaitDays");
  const today = localDay(now.toISOString());
  const rows = db
    .select({ id: tasks.id, title: tasks.title, askedOn: tasks.askedOn, containerId: tasks.containerId, name: people.name, slug: people.slug })
    .from(tasks)
    .innerJoin(people, eq(people.id, tasks.requesterPersonId))
    .leftJoin(taskBlocks, eq(taskBlocks.taskId, tasks.id))
    .where(
      and(
        MINE,
        eq(tasks.status, "open"),
        isNotNull(tasks.askedOn),
        // Asked long enough ago to be a wait rather than a conversation that just happened.
        lte(tasks.askedOn, addDays(today, -waitDays)),
        isNull(taskBlocks.id),
      ),
    )
    .groupBy(tasks.id)
    .all();

  return rows.map((row) => {
    const days = daysBetween(row.askedOn!, today);
    return {
      kind: "commitment_owed" as const,
      source: "task" as const,
      sourceRef: `task:${row.id}`,
      title: row.title,
      detail: `${row.name} has been waiting ${days === 1 ? "a day" : `${days} days`}. No time set aside for it.`,
      payload: { taskId: row.id, personName: row.name, personSlug: row.slug, days, containerId: row.containerId },
      // Climbing from a third of the scale on the first qualifying day to all of it at a
      // fortnight, so a week-old favour outranks a two-day-old one of the same kind.
      urgency: Math.min(1, 0.3 + (days - waitDays) / 14),
    };
  });
};
