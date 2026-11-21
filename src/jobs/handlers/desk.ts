import type { DB } from "@/db/client";
import type { JobHandler } from "@/jobs/worker";
import { sweepDesk } from "@/domain/desk/sweep";

/**
 * The quarter-hour sweep, as a queue entry: a retry and a log line like every other background
 * pass, rather than a thing only an interval can start. All the work is in `sweepDesk`, which
 * `POST /api/desk/refresh` calls directly -- so the button and the timer cannot drift apart.
 */
export function createDeskHandler(deps: { db: DB }): JobHandler {
  return async () => {
    sweepDesk(deps.db, new Date(), (m) => console.log(m));
  };
}
