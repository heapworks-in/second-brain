import { isNull } from "drizzle-orm";
import { observations } from "@/db/schema";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

/** The most asks the desk will carry at once. A backfill can land three hundred mentions in one
 * go, and a proposal row per message would drown the ranker's own history in a single import.
 * The oldest are the ones that matter, so the rest simply wait their turn. */
const ASK_CAP = 20;

/** Trim a message to something readable on one line without cutting mid-word. */
function oneLine(text: string, max = 90): string {
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
  const rows = db.select().from(observations).where(isNull(observations.taskId)).orderBy(observations.at).limit(ASK_CAP).all();

  return rows.flatMap((row) => {
    const hours = (now.getTime() - Date.parse(row.at)) / 3_600_000;
    if (!Number.isFinite(hours) || hours < waitHours) return [];
    const days = Math.floor(hours / 24);
    const who = row.actorName ?? (row.actorHandle ? `@${row.actorHandle}` : "Somebody");
    const where = row.context ? ` in ${row.context}` : "";
    // A message past its TTL has had its text dropped, so the card says where it was rather
    // than pretending to quote something that is no longer held.
    const what = row.text ? oneLine(row.text) : `${who} asked something${where}`;
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
          url: row.url,
          title: what,
        },
        // The same climb as `commitment_owed`, measured from the same zero, so accepting a card
        // does not move it in the list -- only what it is called changes.
        urgency: Math.min(1, 0.3 + (hours / 24 - waitHours / 24) / 14),
      },
    ];
  });
};
