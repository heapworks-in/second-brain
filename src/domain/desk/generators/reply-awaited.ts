import { and, eq, isNull, not, or, sql } from "drizzle-orm";
import { conversations, observations } from "@/db/schema";
import { iSpokeSince, theySpokeSince } from "@/domain/conversations";
import { threshold } from "../thresholds";
import type { Generator } from "../types";
import { judgedAsk, oneLine } from "./ask-unanswered";

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
 * A question of mine is still hanging when my question is the last thing anybody said in that
 * conversation: nobody else has spoken since (`theirsAt`), and neither have I (`mineAt`). The
 * second half is not pedantry -- a question I followed with "thanks, all clear" is one I plainly
 * stopped waiting on, and three questions in a row leave only the last. It misses a question I
 * buried under my own later chatter, which is the right way round: at most one card per
 * conversation, and only when the conversation really did stop on my question.
 *
 * Both facts come from the conversation's own row, which only ever moves forwards, so a pass that
 * does not happen to have the reply on screen cannot make it un-arrive and flap the card. That it
 * is derived rather than reported is why it is *right*: the first version of this took the
 * adaptor's word for "something came after mine", which was true of whatever had been drawn and
 * nothing more.
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
    .select({ row: observations })
    .from(observations)
    .leftJoin(conversations, eq(observations.conversationId, conversations.id))
    .where(
      and(
        isNull(observations.taskId),
        eq(observations.kind, "sent"),
        // Fail-open on a missing conversation: an adaptor that cannot say where a message was
        // said still gets its question chased, exactly as every row behaved before this table.
        not(or(theySpokeSince(observations.at), iSpokeSince(observations.at))!),
        // A model that read the words said this was not really asking for anything. Absent means
        // unjudged, which counts as an ask: no verdict must never be the reason a question is
        // dropped.
        sql`coalesce(json_extract(${observations.meta}, '$.judge.ask'), 1) <> 0`,
      ),
    )
    .orderBy(observations.at)
    .limit(REPLY_CAP)
    .all();

  return rows.flatMap(({ row }) => {
    const hours = (now.getTime() - Date.parse(row.at)) / 3_600_000;
    if (!Number.isFinite(hours) || hours < waitHours) return [];
    const days = Math.floor(hours / 24);
    const where = row.context ? ` in ${row.context}` : "";
    // Past the TTL the text is gone, so the card says where it was rather than quoting something
    // it no longer holds.
    const what = judgedAsk(row.meta) ?? (row.text ? oneLine(row.text) : `Something you asked${where}`);
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
