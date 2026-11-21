import type { DB } from "@/db/client";
import { enqueueJob } from "@/jobs/queue";
import { collectDrafts } from "./generators";
import { reconcileProposals, type ReconcileResult } from "./reconcile";
import { sweepObservationText } from "@/domain/observations";

export type SweepResult = ReconcileResult & {
  /** Observations whose raw text the TTL dropped on this pass. */
  forgotten: number;
};

/**
 * One sweep: ask every generator what it sees, fold the answers into `proposals`.
 *
 * Lives here rather than in the job handler because two things start a sweep -- the quarter-hour
 * interval and the Refresh button -- and they must not be able to do different work. The handler
 * wraps this for the queue's retry and log line; the button calls it directly, because a human
 * who pressed a button is waiting for the answer and handing the work to a worker that polls
 * once a second only means answering before it has happened.
 *
 * The observation TTL rides along rather than running on an interval of its own: it is one
 * UPDATE, it has to happen on a schedule nobody has to remember, and this is already that
 * schedule.
 */
export function sweepDesk(db: DB, now = new Date(), log: (m: string) => void = () => {}): SweepResult {
  const drafts = collectDrafts(db, now, (m) => log(`[desk] ${m}`));
  const result = reconcileProposals(db, drafts, now);
  const forgotten = sweepObservationText(db, now);
  if (forgotten) log(`[desk] dropped the text of ${forgotten} observation(s) past the 14-day TTL`);
  if (result.opened || result.expired || result.returned) {
    log(`[desk] ${result.opened} new, ${result.expired} expired, ${result.returned} back from a snooze`);
  }
  // Newly opened cards have nothing attached yet. Queued rather than done here: the sweep is
  // synchronous and runs behind a button press, and looking something up is a model round trip per
  // card. Only when something opened, so an idle desk queues nothing.
  if (result.opened > 0) {
    try {
      enqueueJob(db, "brief_desk", {});
    } catch (err) {
      log(`[desk] could not queue the context lookup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ...result, forgotten };
}
