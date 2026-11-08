import { and, isNull, lt, ne } from "drizzle-orm";
import { items } from "@/db/schema";
import { suggestContainersFor } from "@/domain/containers/suggest";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

const DAY_MS = 86_400_000;

/**
 * Something captured a while ago that still has no home.
 *
 * The card only exists if it can name where the thing would go. A proposal amounting to "this is
 * unfiled, deal with it" is a reminder, not a decision, and the point of the desk is that every
 * card can be answered in one press.
 *
 * The suggestion is `suggestContainersFor`, the same dull matcher the meeting slice already uses:
 * a shared word of four or more letters between the title and a project or area's name. An
 * earlier version of this ranked the chunk index by FTS instead, and against the real database it
 * confidently offered to file "Mahatma Gandhi's Birthday" into a project called "Task 8
 * Verification Project" -- because an OR of prefix-matched terms will always find *something*,
 * and a wrong destination stated confidently is worse than no card at all. Dull and explainable
 * beats clever and plausible on a surface whose entire value is that you can press the button
 * without checking.
 *
 * It is also provider-free, which generators have to be: synchronous, and no embedding model.
 */
export const captureUnfiled: Generator = (db, now) => {
  const days = threshold(db, "desk.captureUnfiledDays");
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();

  const unfiled = db
    .select({ id: items.id, title: items.title, createdAt: items.createdAt })
    .from(items)
    .where(
      and(
        isNull(items.containerId),
        isNull(items.archivedAt),
        // A journal entry and a weekly review belong to a date, not to a container.
        isNull(items.journalDate),
        isNull(items.reviewWeek),
        lt(items.createdAt, cutoff),
        ne(items.status, "failed"),
      ),
    )
    .all();
  if (unfiled.length === 0) return [];

  // Batched, because `suggestContainersFor` is two queries for the whole list and two per item
  // if called in a loop -- the shape this repository's reviews keep flagging.
  const suggestions = suggestContainersFor(
    db,
    unfiled.map((item) => ({ title: item.title, attendeeNames: [] })),
  );

  return unfiled.flatMap((item, i) => {
    const suggestion = suggestions[i];
    if (!suggestion) return [];
    const age = Math.floor((now.getTime() - Date.parse(item.createdAt)) / DAY_MS);
    return [
      {
        kind: "capture_unfiled" as const,
        source: "item" as const,
        sourceRef: `item:${item.id}`,
        title: item.title,
        detail: `Captured ${age} days ago, still unfiled. Looks like ${suggestion.name}.`,
        payload: { itemId: item.id, containerId: suggestion.id, containerName: suggestion.name },
        // Slow: nothing breaks because a note waited another day, and a card that shouted about
        // filing would be the first thing anyone learns to dismiss.
        urgency: Math.min(0.6, (age - days) / 60 + 0.1),
      },
    ];
  });
};
