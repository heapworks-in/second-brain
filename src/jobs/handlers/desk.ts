import type { DB } from "@/db/client";
import type { JobHandler } from "@/jobs/worker";
import { collectDrafts } from "@/domain/desk/generators";
import { reconcileProposals } from "@/domain/desk/reconcile";
import { sweepObservationText } from "@/domain/observations";

/**
 * One sweep: ask every generator what it sees, fold the answers into `proposals`.
 *
 * All the work is in the domain, deliberately — this exists so the sweep has a queue entry, a
 * retry and a log line like every other background pass, rather than being a thing only an
 * interval can start. `POST /api/desk/refresh` queues the same job, so the button and the timer
 * cannot drift apart.
 *
 * The observation TTL rides along here rather than on an interval of its own: it is one UPDATE,
 * it has to happen on a schedule nobody has to remember, and a sweep that runs every quarter of
 * an hour is already exactly that schedule.
 */
export function createDeskHandler(deps: { db: DB }): JobHandler {
  return async () => {
    const now = new Date();
    const drafts = collectDrafts(deps.db, now, (m) => console.error(`[desk] ${m}`));
    const result = reconcileProposals(deps.db, drafts, now);
    const forgotten = sweepObservationText(deps.db, now);
    if (forgotten) console.log(`[desk] dropped the text of ${forgotten} observation(s) past the 14-day TTL`);
    if (result.opened || result.expired || result.returned) {
      console.log(`[desk] ${result.opened} new, ${result.expired} expired, ${result.returned} back from a snooze`);
    }
  };
}
