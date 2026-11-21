import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { conversations, type Conversation } from "@/db/schema";

/** What an adaptor can say about a place messages happen. */
export interface ConversationInput {
  source: string;
  externalId: string;
  name?: string | null;
  kind?: string | null;
  /** The last message of mine the adaptor could see here, if it saw one. */
  mineAt?: string | null;
  /** The last message of anybody else's. */
  theirsAt?: string | null;
}

/**
 * Slack's own convention, and the only thing an id on its own can tell you: `C` is a channel,
 * `D` a DM, `G` a private group. Worth inferring rather than requiring, because an Activity row
 * gives up a channel id and nothing else -- so a mention can be filed against the right kind of
 * conversation weeks before anybody opens it.
 */
export function kindFromExternalId(externalId: string): string {
  switch (externalId[0]) {
    case "D":
      return "dm";
    case "G":
      return "group";
    default:
      return "channel";
  }
}

/** The later of two timestamps, either of which may be absent or unparseable. */
function latest(a: string | null | undefined, b: string | null | undefined): string | null {
  const at = a && !Number.isNaN(Date.parse(a)) ? a : null;
  const bt = b && !Number.isNaN(Date.parse(b)) ? b : null;
  if (!at) return bt;
  if (!bt) return at;
  return Date.parse(at) >= Date.parse(bt) ? at : bt;
}

/**
 * Upsert one conversation, matching on `(source, externalId)`.
 *
 * The two timestamps only ever move forwards, and that is the whole correctness argument for this
 * table. A reader sees a viewport: the pass that has the reply on screen reports it, and the next
 * pass -- you have scrolled up, or you are looking at a different channel entirely -- reports an
 * older tail, or no tail at all. Taking the reported value as the truth would let that second pass
 * say the reply had un-arrived, which would put a card back on the desk for something answered
 * days ago, take it away on the pass after, and keep doing that every thirty seconds. Keeping the
 * later of the two means a fact, once seen, stays seen.
 *
 * `name` is filled in the same spirit: a pass that cannot read the channel's name must not be
 * able to erase one an earlier pass could.
 */
export function upsertConversation(db: DB, row: ConversationInput, now = new Date()): Conversation {
  const at = now.toISOString();
  const existing = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.source, row.source), eq(conversations.externalId, row.externalId)))
    .get();
  if (existing) {
    const next = {
      name: row.name ?? existing.name,
      kind: row.kind ?? existing.kind,
      mineAt: latest(existing.mineAt, row.mineAt),
      theirsAt: latest(existing.theirsAt, row.theirsAt),
      lastSeenAt: at,
      updatedAt: at,
    };
    return db.update(conversations).set(next).where(eq(conversations.id, existing.id)).returning().get()!;
  }
  return db
    .insert(conversations)
    .values({
      source: row.source,
      externalId: row.externalId,
      name: row.name ?? null,
      kind: row.kind ?? kindFromExternalId(row.externalId),
      mineAt: latest(null, row.mineAt),
      theirsAt: latest(null, row.theirsAt),
      lastSeenAt: at,
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get()!;
}

/**
 * The conversation a message's `externalId` belongs to, created empty if this is the first time
 * it has been heard of.
 *
 * Slack's observation ids are `<channel>/<ts>`, so the conversation is derivable from the message
 * alone -- which matters for an Activity row, where the channel id is all there is and nobody has
 * opened the channel yet. Returns null for an id with no conversation part rather than inventing
 * one, so a future adaptor with a different id scheme degrades to "no conversation known" instead
 * of filling this table with rubbish.
 */
export function conversationForMessage(db: DB, source: string, externalId: string, now = new Date()): Conversation | null {
  const slash = externalId.indexOf("/");
  if (slash <= 0) return null;
  return upsertConversation(db, { source, externalId: externalId.slice(0, slash) }, now);
}

export function getConversation(db: DB, id: number): Conversation | undefined {
  return db.select().from(conversations).where(eq(conversations.id, id)).get();
}

/**
 * `true` when somebody other than me has spoken in this conversation since `at`.
 *
 * Expressed as SQL against a joined `conversations` row rather than as a function, because the
 * generators have to apply it inside a query: their cap is applied by LIMIT, and twenty answered
 * asks filtered out after the fetch would starve twenty real ones behind them.
 */
export const theySpokeSince = (at: unknown) =>
  // Parenthesised, because callers wrap this in `not(...)` and drizzle renders that as a bare
  // `not <expr>`. Without the brackets `not (a and b)` becomes `(not a) and b`, which is a
  // different question with a plausible-looking answer -- the failure mode that makes a generator
  // quietly stop emitting rather than throw.
  sql`(${conversations.theirsAt} is not null and ${conversations.theirsAt} > ${at})`;

/** `true` when I have spoken in this conversation since `at` -- which is what answering is. */
export const iSpokeSince = (at: unknown) => sql`(${conversations.mineAt} is not null and ${conversations.mineAt} > ${at})`;
