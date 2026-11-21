import { and, eq, isNull, not, notInArray, sql } from "drizzle-orm";
import { conversations, observations } from "@/db/schema";
import { iSpokeSince } from "@/domain/conversations";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

/** The most asks the desk will carry at once. A backfill can land three hundred mentions in one
 * go, and a proposal row per message would drown the ranker's own history in a single import.
 * The oldest are the ones that matter, so the rest simply wait their turn. */
const ASK_CAP = 20;

/**
 * What a model made of the message, when one read it.
 *
 * `judge.what` is one phrase saying what is actually being asked for, which beats the first
 * ninety characters of a message: "needs the staging credentials" against "hey -- sorry to bother
 * you again, I know you said". Absent for anything unjudged (no model installed, the job has not
 * run yet, or it ran and could not decide), and absent is handled everywhere rather than guessed
 * at: an unjudged ask reads exactly as it did before any of this existed.
 */
export function judgedAsk(meta: string): string | null {
  try {
    const what = (JSON.parse(meta) as { judge?: { what?: unknown } }).judge?.what;
    return typeof what === "string" && what.trim() !== "" ? oneLine(what) : null;
  } catch {
    return null;
  }
}

/** Trim a message to something readable on one line without cutting mid-word. */
export function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > 40 ? cut.slice(0, space) : cut}…`;
}

/**
 * Somebody asked something in a tool outside this app, and it was never answered here.
 *
 * The only generator whose evidence comes from off the machine's own tables -- an adaptor in the
 * sibling `sb-adaptors` repo read it and posted it. Everything it needs is already on the row,
 * because adaptors are deliberately dumb: they report what they saw, and the judgement about
 * what it means is this file and nothing else.
 *
 * Accepting turns it into an owed commitment, which is why the urgency formula matches
 * `commitment_owed`'s exactly: an ask crossing from one to the other must not jump in the list.
 *
 * The wait is counted in hours rather than days because an ask arrives at a time, not on a
 * date, and four hours is the honest floor -- a mention from this morning that you are in the
 * middle of replying to is a conversation, not a backlog.
 */
export const askUnanswered: Generator = (db, now) => {
  const waitHours = threshold(db, "desk.askWaitHours");
  // Broadcasts are excluded in SQL, not after the fetch: the cap is applied by the query, so
  // twenty `@channel` announcements would otherwise fill it and starve every real ask behind them.
  // `kind` is settled at ingest (classifyKind) precisely so this still holds once the text's TTL
  // has dropped the words it was judged on.
  //
  // `sent` is mine, not an ask of anybody's -- it belongs to `reply_awaited`, and left in here it
  // would put my own question on the board as something I owe a reply to.
  const rows = db
    .select({ row: observations })
    .from(observations)
    .leftJoin(conversations, eq(observations.conversationId, conversations.id))
    .where(
      and(
        isNull(observations.taskId),
        notInArray(observations.kind, ["broadcast", "sent"]),
        // Answered means I have spoken in that conversation since they asked. This is the whole
        // reason `conversations` exists: without it the only honest answer to "did I reply?" was
        // "no idea", so a mention you had dealt with in Slack hours ago kept its card until you
        // came in here and dismissed it by hand -- which is a nag list, not a queue. Nothing about
        // the reply is stored; that I spoke at all is the entire fact.
        //
        // Fail-open on a missing conversation, so a row from an adaptor that cannot say where a
        // message was said behaves as every row did before this column existed.
        not(iSpokeSince(observations.at)),
        // A model that read the words said this was not asking me for anything. Absent means
        // unjudged, and unjudged counts as an ask: a missing verdict must never silently drop
        // something somebody is waiting on.
        sql`coalesce(json_extract(${observations.meta}, '$.judge.ask'), 1) <> 0`,
      ),
    )
    .orderBy(observations.at)
    .limit(ASK_CAP)
    .all();

  return rows.flatMap(({ row }) => {
    const hours = (now.getTime() - Date.parse(row.at)) / 3_600_000;
    if (!Number.isFinite(hours) || hours < waitHours) return [];
    const days = Math.floor(hours / 24);
    const who = row.actorName ?? (row.actorHandle ? `@${row.actorHandle}` : "Somebody");
    const where = row.context ? ` in ${row.context}` : "";
    // A message past its TTL has had its text dropped, so the card says where it was rather
    // than pretending to quote something that is no longer held.
    const what = judgedAsk(row.meta) ?? (row.text ? oneLine(row.text) : `${who} asked something${where}`);
    const waited = days >= 1 ? `${days === 1 ? "a day" : `${days} days`}` : `${Math.floor(hours)}h`;
    return [
      {
        kind: "ask_unanswered" as const,
        source: "observation" as const,
        sourceRef: `observation:${row.id}`,
        title: what,
        detail: `${who} asked${where} on ${row.source}, ${waited} ago. Nothing here owes it back yet.`,
        payload: {
          observationId: row.id,
          actorHandle: row.actorHandle,
          actorName: row.actorName,
          askedAt: row.at,
          // The channel, so the row's origin names where it was said rather than falling back to
          // who said it -- `originOf` has always read this key and nothing has ever written it.
          context: row.context,
          url: row.url,
          title: what,
          personId: row.personId,
        },
        // The same climb as `commitment_owed`, measured from the same zero, so accepting a card
        // does not move it in the list -- only what it is called changes.
        urgency: Math.min(1, 0.3 + (hours / 24 - waitHours / 24) / 14),
      },
    ];
  });
};
