import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { observations, type Observation } from "@/db/schema";
import { conversationForMessage, upsertConversation, type ConversationInput } from "@/domain/conversations";
import { findActor } from "@/domain/people";
import { enqueueJob } from "@/jobs/queue";
import { nowIso } from "@/lib/time";

/**
 * What an adaptor hands the ingest route. The shape is the contract documented in the sibling
 * `sb-adaptors` repo (docs/specs/2026-11-14-adaptors-design.md); keep the two in step.
 */
export interface ObservationInput {
  source: string;
  externalId: string;
  at: string;
  kind: string;
  actorHandle?: string | null;
  actorName?: string | null;
  text?: string;
  url?: string | null;
  context?: string | null;
  meta?: Record<string, unknown>;
}

export interface IngestResult {
  accepted: number;
  updated: number;
}

/** What one POST carries: the messages, and what is known about the places they were said. */
export interface IngestBatch {
  observations: ObservationInput[];
  conversations?: ConversationInput[];
}

/** Days raw message text is kept for an observation nobody acted on. */
export const TEXT_TTL_DAYS = 14;

/**
 * A message that opens with one of these was addressed to a room, not to you.
 *
 * Slack's Activity view lists `@channel` announcements beside genuine mentions, and on a busy
 * announcements channel they are nearly all of it -- a real workspace showed eleven consecutive
 * job-posting broadcasts and not one personal ask. Treated as asks they would fill the desk's cap
 * of twenty and starve the mentions that actually owe somebody a reply.
 */
const BROADCAST_OPENERS = /^\s*@(channel|here|everyone)\b/i;

/**
 * Settled once, at ingest, rather than inferred later from the text.
 *
 * Text is dropped after TEXT_TTL_DAYS, so a generator asking "does this read like a broadcast?"
 * would start answering "no" on day fifteen and raise a card for an announcement nobody owes.
 * Deciding here keeps it true for as long as the row exists -- and it is decided for every adaptor
 * at once, which matters because the Chrome one reads the same view and had the same problem.
 *
 * This is the server judging, which is its job: the adaptor reported faithfully what it saw.
 */
export function classifyKind(kind: string, text?: string): string {
  // Not my own messages. "Addressed to a room rather than to you" is a statement about somebody
  // else's message; applied to one of mine it would read my own `@here anyone know …?` as an
  // announcement and drop the question I am waiting on an answer to.
  if (kind === "sent") return kind;
  return text && BROADCAST_OPENERS.test(text) ? "broadcast" : kind;
}

/**
 * What an adaptor said before, kept when a later pass does not repeat it.
 *
 * `answeredAt` is the case this exists for. A reader sees a conversation through a viewport: the
 * pass that renders the reply reports it, and the next pass -- the person has scrolled, or the
 * window is showing the tail again -- may not. Replacing `meta` wholesale would let that second
 * pass say the reply had un-arrived, which would put a card back on the desk for a question that
 * was answered days ago, take it away again on the pass after, and do it all over every half
 * minute. A fact an adaptor has reported once is therefore kept until it reports a different value
 * for it.
 */
function mergeMeta(stored: string, incoming: Record<string, unknown> | undefined): string {
  if (!incoming) return stored;
  try {
    return JSON.stringify({ ...(JSON.parse(stored) as Record<string, unknown>), ...incoming });
  } catch {
    return JSON.stringify(incoming);
  }
}

/**
 * Upsert a batch, matching on `(source, externalId)`.
 *
 * Re-running a backfill must not duplicate: a backfill is a scroll back through Slack's Activity
 * view and a scroll overlaps itself by design -- the same mention is read on two passes as the
 * viewport moves over it.
 *
 * `taskId` is pointedly not in the update set. An observation already turned into a task stays
 * linked to it even when a later backfill reads the same message again, so re-importing cannot
 * resurrect an ask that has already been dealt with.
 */
export function ingestObservations(db: DB, rows: ObservationInput[], now = new Date()): IngestResult {
  return ingestBatch(db, { observations: rows }, now);
}

/**
 * Upsert a batch, matching on `(source, externalId)`.
 *
 * Re-running a backfill must not duplicate: a backfill is a scroll back through Slack's Activity
 * view and a scroll overlaps itself by design -- the same mention is read on two passes as the
 * viewport moves over it.
 *
 * `taskId` is pointedly not in the update set. An observation already turned into a task stays
 * linked to it even when a later backfill reads the same message again, so re-importing cannot
 * resurrect an ask that has already been dealt with.
 *
 * Conversations are folded in first, because a message's own row points at one: the reader
 * reports what it could see of each conversation's tail, and `upsertConversation` only ever moves
 * those timestamps forwards. A message whose conversation the batch said nothing about still gets
 * one, derived from its id -- an Activity row names a channel nobody has opened yet, and the card
 * it raises should expire the day you finally reply there.
 */
export function ingestBatch(db: DB, batch: IngestBatch, now = new Date()): IngestResult {
  const at = now.toISOString();
  const result: IngestResult = { accepted: 0, updated: 0 };
  // `db` inside, not the handed-down `tx`: better-sqlite3 is synchronous, so the outer handle is
  // inside the same transaction, and it is what the helpers here take. The same shape as
  // `createTask` and `placeBlock`.
  db.transaction(() => {
    for (const conversation of batch.conversations ?? []) upsertConversation(db, conversation, now);
    for (const row of batch.observations) {
      const existing = db
        .select({ id: observations.id, meta: observations.meta })
        .from(observations)
        .where(and(eq(observations.source, row.source), eq(observations.externalId, row.externalId)))
        .get();
      const kind = classifyKind(row.kind, row.text);
      const values = {
        at: row.at,
        kind,
        actorHandle: row.actorHandle ?? null,
        actorName: row.actorName ?? null,
        text: row.text ?? "",
        url: row.url ?? null,
        context: row.context ?? null,
        meta: JSON.stringify(row.meta ?? {}),
        updatedAt: at,
        conversationId: conversationForMessage(db, row.source, row.externalId, now)?.id ?? null,
        // `sent` is mine, and I am not a row in `people`.
        personId: kind === "sent" ? null : (findActor(db, row.actorName ?? null, row.actorHandle ?? null)?.id ?? null),
      };
      if (existing) {
        db.update(observations)
          .set({ ...values, meta: mergeMeta(existing.meta, row.meta) })
          .where(eq(observations.id, existing.id))
          .run();
        result.updated += 1;
      } else {
        const inserted = db
          .insert(observations)
          .values({ source: row.source, externalId: row.externalId, ...values, createdAt: at })
          .returning({ id: observations.id })
          .get();
        result.accepted += 1;
        // Judged once, on arrival, and only for something there are words to judge. The text is
        // gone in fourteen days, so a verdict that reads the words has to be reached while they
        // are still here -- and reached once, not on every sweep, because it costs a local model
        // a round trip. A broadcast is not judged at all: it was addressed to a room, which is
        // already the whole verdict.
        if (inserted && values.text.trim() !== "" && kind !== "broadcast") {
          enqueueJob(db, "judge_message", { observationId: inserted.id });
        }
      }
    }
  });
  return result;
}

/** Everything nobody has turned into a task yet, oldest ask first. */
export function openObservations(db: DB, limit: number): Observation[] {
  return db.select().from(observations).where(isNull(observations.taskId)).orderBy(asc(observations.at)).limit(limit).all();
}

export function linkObservationToTask(db: DB, id: number, taskId: number | null): void {
  db.update(observations).set({ taskId, updatedAt: nowIso() }).where(eq(observations.id, id)).run();
}

/**
 * Drop the raw text of anything older than the TTL that nobody acted on.
 *
 * The guardrail agreed for captured content, applied here rather than left to a person to
 * remember: raw message text lives 14 days unless accepting a card turned it into a task, in
 * which case the task refers to it and it stays. The row itself survives either way -- it is
 * what stops a backfill re-proposing a message that was already dismissed months ago.
 */
export function sweepObservationText(db: DB, now = new Date(), days = TEXT_TTL_DAYS): number {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return db
    .update(observations)
    .set({ text: "" })
    .where(and(isNull(observations.taskId), lt(observations.at, cutoff), sql`${observations.text} <> ''`))
    .run().changes;
}

export function getObservation(db: DB, id: number): Observation | undefined {
  return db.select().from(observations).where(eq(observations.id, id)).get();
}
