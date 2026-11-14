import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { observations, type Observation } from "@/db/schema";
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

/** Days raw message text is kept for an observation nobody acted on. */
export const TEXT_TTL_DAYS = 14;

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
  const at = now.toISOString();
  const result: IngestResult = { accepted: 0, updated: 0 };
  db.transaction((tx) => {
    for (const row of rows) {
      const existing = tx
        .select({ id: observations.id })
        .from(observations)
        .where(and(eq(observations.source, row.source), eq(observations.externalId, row.externalId)))
        .get();
      const values = {
        at: row.at,
        kind: row.kind,
        actorHandle: row.actorHandle ?? null,
        actorName: row.actorName ?? null,
        text: row.text ?? "",
        url: row.url ?? null,
        context: row.context ?? null,
        meta: JSON.stringify(row.meta ?? {}),
        updatedAt: at,
      };
      if (existing) {
        tx.update(observations).set(values).where(eq(observations.id, existing.id)).run();
        result.updated += 1;
      } else {
        tx.insert(observations)
          .values({ source: row.source, externalId: row.externalId, ...values, createdAt: at })
          .run();
        result.accepted += 1;
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
