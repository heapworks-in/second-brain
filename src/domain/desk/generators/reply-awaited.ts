import { and, eq, isNull, sql } from "drizzle-orm";
import { observations } from "@/db/schema";
import { threshold } from "../thresholds";
import type { Generator } from "../types";
import { oneLine } from "./ask-unanswered";

/** The same cap, for the same reason: one import must not be able to fill the desk. */
const REPLY_CAP = 20;

/**
 * I asked somebody something and nothing has come back.
 *
 * The mirror of `ask_unanswered`, and the half that is easy to lose: an ask I owe arrives in
 * Slack's Activity view and nags, while a question I asked disappears the moment I scroll past
 * it -- nobody is going to remind me that they never answered. The thing that was blocked stays
 * blocked, quietly, and the only person who ever finds out is me, late.
 *
 * Whether a reply came is a fact the adaptor can see and this cannot, so it reports it:
 * `meta.answeredAt` is set when a later message in the same conversation was rendered after
 * mine. Ingest upserts on `(source, externalId)`, so a pass that finally sees the reply updates
 * the row, this stops emitting, and `reconcileProposals` takes the card away. Nothing here has
 * to go looking.
 *
 * A working day, not four hours. The inbound floor is short because I owe a reply quickly; this
 * one is long because somebody else does not owe me one quickly, and a card raised the same
 * afternoon would be impatience with a person rather than a thing I can act on.
 */
export const replyAwaited: Generator = (db, now) => {
  const waitHours = threshold(db, "desk.replyWaitHours");
  // The answered ones are excluded in SQL rather than after the fetch, so twenty answered
  // messages cannot fill the cap and starve the questions still hanging.
  const rows = db
    .select()
    .from(observations)
    .where(
      and(
        isNull(observations.taskId),
        eq(observations.kind, "sent"),
        sql`json_extract(${observations.meta}, '$.answeredAt') is null`,
      ),
    )
    .orderBy(observations.at)
    .limit(REPLY_CAP)
    .all();

  return rows.flatMap((row) => {
    const hours = (now.getTime() - Date.parse(row.at)) / 3_600_000;
    if (!Number.isFinite(hours) || hours < waitHours) return [];
    const days = Math.floor(hours / 24);
    const where = row.context ? ` in ${row.context}` : "";
    // Past the TTL the text is gone, so the card says where it was rather than quoting something
    // it no longer holds.
    const what = row.text ? oneLine(row.text) : `Something you asked${where}`;
    const waited = days >= 1 ? `${days === 1 ? "a day" : `${days} days`}` : `${Math.floor(hours)}h`;
    return [
      {
        kind: "reply_awaited" as const,
        source: "observation" as const,
        sourceRef: `observation:${row.id}`,
        title: what,
        detail: `You asked${where} on ${row.source} ${waited} ago. Nothing has come back.`,
        payload: {
          observationId: row.id,
          askedAt: row.at,
          context: row.context,
          url: row.url,
          title: what,
        },
        // The same climb as the ask it mirrors, so the two sort against each other honestly when
        // a day has gone by on both.
        urgency: Math.min(1, 0.3 + (hours / 24 - waitHours / 24) / 14),
      },
    ];
  });
};
