import type { DB } from "@/db/client";
import type { JobHandler } from "@/jobs/worker";
import { collectDrafts } from "@/domain/desk/generators";
import { reconcileProposals } from "@/domain/desk/reconcile";

/**
 * One sweep: ask every generator what it sees, fold the answers into `proposals`.
 *
 * All the work is in the domain, deliberately — this exists so the sweep has a queue entry, a
 * retry and a log line like every other background pass, rather than being a thing only an
 * interval can start. `POST /api/desk/refresh` queues the same job, so the button and the timer
 * cannot drift apart.
 */
export function createDeskHandler(deps: { db: DB }): JobHandler {
  return async () => {
    const now = new Date();
    const drafts = collectDrafts(deps.db, now, (m) => console.error(`[desk] ${m}`));
    const result = reconcileProposals(deps.db, drafts, now);
    if (result.opened || result.expired || result.returned) {
      console.log(`[desk] ${result.opened} new, ${result.expired} expired, ${result.returned} back from a snooze`);
    }
  };
}
