import { and, eq, isNull, sql } from "drizzle-orm";
import { items } from "@/db/schema";
import { parseMeta } from "@/domain/items";
import type { Generator } from "../types";

const DAY_MS = 86_400_000;

/** What a meeting item's `meta` holds, of the parts this reads. The summary is written by the
 * `summarize_meeting` job; `acceptedActions` by whoever booked one. */
interface MeetingMeta {
  summary?: { proposed_actions?: { title?: unknown; owner?: unknown; notes?: unknown }[] };
  acceptedActions?: number[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Something said out loud in a meeting, written down by the summariser, and never turned into
 * anything that will be looked at again.
 *
 * This is the highest-value card in the slice and the cheapest to answer, which is why its weight
 * is second only to a meeting about to start: the work of remembering has already been done by
 * the summariser, and the only thing between a commitment and a lost commitment is one press.
 *
 * One proposal per action, not per meeting -- `sourceRef` carries the index -- so booking one
 * does not dismiss the three beside it, and dismissing one does not hide the rest. The index is
 * also why `acceptedActions` is read rather than the task list: it is the same bookkeeping the
 * meeting page's own accept button writes, so the two surfaces cannot disagree about what has
 * already been booked.
 */
export const commitmentUnbooked: Generator = (db, now) => {
  const rows = db
    .select({ id: items.id, title: items.title, meta: items.meta, containerId: items.containerId, createdAt: items.createdAt })
    .from(items)
    .where(and(eq(items.type, "meeting"), isNull(items.archivedAt), sql`${items.meta} like '%proposed_actions%'`))
    .all();

  return rows.flatMap((row) => {
    const meta = parseMeta<MeetingMeta>(row as Parameters<typeof parseMeta>[0]);
    // Model output, so the shape is checked rather than trusted: a summariser that answered
    // with a string here used to take the whole sweep down with it.
    const raw = meta.summary?.proposed_actions;
    const actions = Array.isArray(raw) ? raw : [];
    const accepted = new Set(meta.acceptedActions ?? []);
    const age = Math.floor((now.getTime() - Date.parse(row.createdAt)) / DAY_MS);

    return actions.flatMap((action, index) => {
      const title = text(action?.title);
      if (!title || accepted.has(index)) return [];
      const owner = text(action?.owner);
      return [
        {
          kind: "commitment_unbooked" as const,
          source: "item" as const,
          sourceRef: `action:${row.id}:${index}`,
          title,
          detail: owner ? `${owner}, from ${row.title} ${age === 0 ? "today" : `${age} days ago`}. Not booked.` : `From ${row.title} ${age === 0 ? "today" : `${age} days ago`}. Not booked.`,
          payload: { itemId: row.id, index, title, notes: text(action?.notes), containerId: row.containerId, meetingTitle: row.title },
          // Fresh out of the meeting is when it is cheapest to act on, and a fortnight later it
          // has either been done another way or quietly abandoned. Decaying rather than growing
          // is the opposite of every other kind here, and deliberate.
          urgency: Math.max(0.15, 1 - age / 14),
        },
      ];
    });
  });
};
