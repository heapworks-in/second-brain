import { and, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import { containers, items } from "@/db/schema";
import { ftsSearch } from "@/domain/search/fts";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

const DAY_MS = 86_400_000;
/** Enough hits to be sure which container is actually the nearest, few enough to stay one query. */
const LOOKUP_LIMIT = 8;

/**
 * Something captured a while ago that still has no home.
 *
 * The card only exists if it can name where the thing would go. A proposal that amounts to "this
 * is unfiled, deal with it" is a reminder, not a decision, and the whole point of the desk is
 * that every card can be answered in one press. So the suggestion is found first and the card is
 * skipped when there is none -- which means this generator is quiet on a young database and gets
 * steadily more useful as there is more to be similar to.
 *
 * Nearness is full-text, not embeddings: generators are synchronous and the embedding provider
 * can be switched off entirely (`SB_EMBED=off`). A desk that empties out when a model is missing
 * would be worse than no desk, and FTS over the chunks is already indexed and already there.
 */
export const captureUnfiled: Generator = (db, now) => {
  const days = threshold(db, "desk.captureUnfiledDays");
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();

  const unfiled = db
    .select({ id: items.id, title: items.title, type: items.type, createdAt: items.createdAt })
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

  return unfiled.flatMap((item) => {
    // The nearest *filed* item's container. Its own chunks are excluded: a note is always its own
    // closest match, and it has no container to suggest anyway.
    const hits = ftsSearch(db, item.title, { limit: LOOKUP_LIMIT });
    const candidateIds = hits.map((h) => h.itemId).filter((id) => id !== item.id);
    if (candidateIds.length === 0) return [];

    // One query for every candidate, then walked in the order FTS ranked them: taking whichever
    // row SQLite happened to return first would throw away the ranking that chose them.
    const byItem = new Map(
      db
        .select({ itemId: items.id, containerId: containers.id, name: containers.name })
        .from(items)
        .innerJoin(containers, eq(containers.id, items.containerId))
        .where(inArray(items.id, candidateIds))
        .all()
        .map((r) => [r.itemId, r]),
    );
    const suggestion = candidateIds.map((id) => byItem.get(id)).find((hit) => hit !== undefined);
    if (!suggestion) return [];

    const age = Math.floor((now.getTime() - Date.parse(item.createdAt)) / DAY_MS);
    return [
      {
        kind: "capture_unfiled" as const,
        source: "item" as const,
        sourceRef: `item:${item.id}`,
        title: item.title,
        detail: `Captured ${age} days ago, still unfiled. Closest match sits in ${suggestion.name}.`,
        payload: { itemId: item.id, containerId: suggestion.containerId, containerName: suggestion.name },
        // Slow: nothing breaks because a note waited another day, and a card that shouts about
        // filing would be the first thing anyone learns to dismiss.
        urgency: Math.min(0.6, (age - days) / 60 + 0.1),
      },
    ];
  });
};
