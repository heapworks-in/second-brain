import { eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { items } from "@/db/schema";
import { getItem, parseMeta } from "@/domain/items";
import { enqueueJob, listJobs } from "@/jobs/queue";
import { MeetingError } from "./errors";

interface SummaryMeta {
  summary?: unknown;
}

/** True when the item has something a summary could be written from. */
function hasMaterial(text: string, body: string): boolean {
  return text.trim().length > 0 || body.trim().length > 0;
}

/**
 * Queue a summary for one meeting, by hand.
 *
 * Deliberately not "retry the failed job": a summary job that had nothing to run completes
 * successfully having written only a reason onto the item, so `retryFailedJobsForItem` -- what
 * the Retry button on an ordinary item uses -- finds nothing to retry and the meeting stays
 * without a summary for ever. This queues a fresh pass instead, which is what the person
 * pressing the button means.
 */
export function queueSummary(db: DB, itemId: number): void {
  const item = getItem(db, itemId);
  if (!item) throw new MeetingError(`Item ${itemId} not found`, 404);
  if (item.type !== "meeting") throw new MeetingError("Only a meeting can be summarised", 400);
  if (!hasMaterial(item.extractedText, item.body)) {
    throw new MeetingError("There is no transcript and no notes to summarise yet", 400);
  }
  // A second press while the first pass is still thinking would run the 7B model twice over the
  // same transcript, back to back, on a serial queue.
  const pending = listJobs(db, { itemId }).some((j) => j.type === "summarize_meeting" && (j.status === "queued" || j.status === "running"));
  if (pending) return;
  enqueueJob(db, "summarize_meeting", { itemId }, itemId);
}

/**
 * Meetings that have a transcript but were never offered a summary at all.
 *
 * `transcribe_final` used to queue the summary only when the model happened to be installed as
 * it finished, and nothing ever revisited that decision: every meeting recorded while the app
 * was still fetching its 4.4 GB model lost its summary permanently and silently. The gate is
 * gone, and this heals the meetings it already cost -- those with words on them and no summary
 * job in their history. An item that was offered a pass and failed is left alone: it has a
 * reason recorded, and re-running a wedged transcript on every boot helps nobody.
 */
export function sweepMissingSummaries(db: DB, log?: (message: string) => void): number {
  const meetings = db.select().from(items).where(eq(items.type, "meeting")).all();
  let queued = 0;
  for (const item of meetings) {
    if (parseMeta<SummaryMeta>(item).summary) continue;
    if (!hasMaterial(item.extractedText, item.body)) continue;
    if (listJobs(db, { itemId: item.id }).some((j) => j.type === "summarize_meeting")) continue;
    enqueueJob(db, "summarize_meeting", { itemId: item.id }, item.id);
    queued += 1;
  }
  if (queued > 0) log?.(`queued a summary for ${queued} meeting(s) that never had one`);
  return queued;
}
