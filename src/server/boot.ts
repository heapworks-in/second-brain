import fs from "node:fs";
import type { DB } from "@/db/client";
import { getDb } from "@/db/client";
import { JobWorker } from "@/jobs/worker";
import { createJobHandlers } from "@/jobs/handlers";
import { resetRunningJobs, enqueueJob } from "@/jobs/queue";
import { backupFilePath } from "@/jobs/handlers/backup";
import { migrateNextSteps } from "@/domain/tasks/migrate-next-steps";
import { autoStartTick } from "@/domain/meetings/auto-start";
import { distillSweepTick, QUIET_MINUTES } from "@/domain/distill";
import { reconcileRecordings, stopForShutdown } from "@/domain/meetings/reconcile";
import { sweepMissingSummaries } from "@/domain/meetings/summarize";
import { summaryUnavailable } from "@/providers/chat";
import { syncCalendarFeed } from "@/domain/activity";
import { checkOpenDatabase, recordDbCheck, getLastDbCheck } from "@/db/safety";
import { getGistProvider } from "@/providers/gist";
import { getEmbedProvider } from "./providers";

export { getLastDbCheck };

const g = globalThis as unknown as {
  __sbWorker?: JobWorker;
  __sbBackupInterval?: NodeJS.Timeout;
  __sbAutoStartInterval?: NodeJS.Timeout;
  __sbFeedInterval?: NodeJS.Timeout;
  __sbDistillInterval?: NodeJS.Timeout;
  __sbDeskInterval?: NodeJS.Timeout;
  __sbShutdownHooked?: boolean;
};

/** A published calendar is republished every few minutes; polling faster only re-fetches the same file. */
const FEED_CHECK_MS = 5 * 60_000;
const FEED_FIRST_MS = 15_000;

/** Every 6 hours we check whether today's backup exists yet; cheap enough to just poll. */
const BACKUP_CHECK_MS = 6 * 60 * 60 * 1000;

/** Half a minute: fine enough to catch a meeting's start inside the two-minute window. */
const AUTO_START_CHECK_MS = 30 * 1000;

/** Matches `QUIET_MINUTES`: no point checking more often than an item can newly go quiet. */
const DISTILL_CHECK_MS = QUIET_MINUTES * 60_000;

/** The desk sweep. A quarter of an hour is the resolution of the most time-sensitive thing it
 * notices -- a meeting four hours out -- and anything faster would only re-read the same tables
 * to reach the same answer. */
const DESK_CHECK_MS = 15 * 60_000;
/** Soon after boot, not instantly: the first sweep has to wait for the calendar sync above, or
 * the desk's first impression of the day is drawn from whatever the last sync left. */
const DESK_FIRST_MS = 45_000;

function ensureTodayBackupQueued(db: DB): void {
  if (!fs.existsSync(backupFilePath())) enqueueJob(db, "backup", {});
}

/**
 * Ask the recorder to stop before the process goes, so `sb-recorder` flushes its WAV header
 * and next boot's sweep finds a playable file. Once per process: HMR re-runs `boot`, and a
 * stack of handlers would each try to stop the same helper.
 *
 * Under `next start` Next registers its own signal cleanup first and exits on its own once
 * the HTTP server has closed, so the 3 s budget is best effort, not a guarantee: launchd
 * signals the whole process group and `sb-recorder` handles SIGTERM itself, which is what
 * actually keeps the WAV whole when this handler is cut short.
 */
function hookShutdown(): void {
  if (g.__sbShutdownHooked) return;
  g.__sbShutdownHooked = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void stopForShutdown({ log: (m) => console.log(`[shutdown] ${m}`) }).finally(() => {
        // This handler is gone with `once`; the re-raise reaches Next's own cleanup (already
        // running, so a no-op) or, without it, Node's default exit.
        process.kill(process.pid, signal);
      });
    });
  }
}

/**
 * `integrity_check`, `foreign_key_check`, and (once the database has chunks) the same FTS/vec0
 * probes the backup job runs -- `checkOpenDatabase` covers exactly what `verifyDatabaseFile`
 * does, so this and the nightly backup's own check cannot disagree about the same database.
 * Silence means checked and sound, not unchecked -- so this always runs, logs its result either
 * way, and records it through `recordDbCheck` for the status surface. On failure it does nothing
 * else: no auto-restore, no repair. A database that fails a foreign-key check is still one you
 * want to be able to open and read, and a program that tries to fix its own corruption unattended
 * is how a recoverable problem becomes an unrecoverable one. `checkOpenDatabase` itself never
 * throws, but this is wrapped anyway, in keeping with every other boot step here: nothing this
 * function does is allowed to be the reason the worker never starts.
 */
function checkDatabaseOnBoot(db: DB): void {
  try {
    const check = checkOpenDatabase(db);
    recordDbCheck(check, "boot");
    if (check.ok) {
      console.log("[boot] database integrity check passed");
    } else {
      console.error(`[boot] database integrity check FAILED: ${check.problems.join("; ")}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[boot] database integrity check could not run: ${message}`);
    recordDbCheck({ ok: false, problems: [message] }, "boot");
  }
}

export function boot(): JobWorker {
  if (g.__sbWorker) return g.__sbWorker;
  const db = getDb();
  checkDatabaseOnBoot(db);
  const reset = resetRunningJobs(db);
  if (reset > 0) console.log(`[boot] requeued ${reset} interrupted job(s)`);
  try {
    const swept = reconcileRecordings(db, (m) => console.log(`[boot] ${m}`));
    if (swept.done + swept.failed > 0) console.log(`[boot] closed ${swept.done + swept.failed} interrupted recording(s)`);
  } catch (err) {
    console.error(`[boot] could not reconcile recordings:`, err);
  }
  hookShutdown();
  try {
    const m = migrateNextSteps(db);
    if (m.containers) console.log(`[boot] migrated ${m.containers} next-steps checklist(s) into ${m.tasks} task(s)`);
  } catch (err) {
    console.error(`[boot] next-steps migration failed:`, err);
  }
  try {
    sweepMissingSummaries(db, (m) => console.log(`[boot] ${m}`));
  } catch (err) {
    console.error(`[boot] could not sweep for missing summaries:`, err);
  }
  const embed = getEmbedProvider();
  if (!embed) console.warn("[boot] SB_EMBED=off: semantic search disabled");
  // Read once for the log line; the handlers ask again per job, so a model installed later works.
  // Says why, not just that: the reason comes from the same resolver the job uses, so a machine
  // with a runtime holding the model logs nothing and a machine with neither says which.
  void summaryUnavailable().then((why) => {
    if (why) console.log(`[boot] meeting summaries are off — ${why}`);
  });
  const worker = new JobWorker(db, createJobHandlers({ db, embed }), {
    log: (m) => console.log(`[worker] ${m}`),
  });
  worker.start();
  if (embed) {
    void embed
      .embed(["warmup"])
      .then(() => console.log("[boot] embedding model ready"))
      .catch((err) => console.warn(`[boot] embedding model unavailable: ${err instanceof Error ? err.message : String(err)}`));
  }
  g.__sbWorker = worker;
  ensureTodayBackupQueued(db);
  if (!g.__sbBackupInterval) {
    g.__sbBackupInterval = setInterval(() => ensureTodayBackupQueued(db), BACKUP_CHECK_MS);
  }
  if (!g.__sbFeedInterval) {
    // A published calendar link, when one is set; the sync records its own errors.
    const feed = () => void syncCalendarFeed(db, { log: (m) => console.log(`[calendar-feed] ${m}`) });
    setTimeout(feed, FEED_FIRST_MS).unref();
    g.__sbFeedInterval = setInterval(feed, FEED_CHECK_MS);
  }
  if (!g.__sbAutoStartInterval) {
    // The tick swallows its own errors; the setting it reads decides whether it does anything.
    g.__sbAutoStartInterval = setInterval(() => void autoStartTick(db, { log: (m) => console.log(`[auto-record] ${m}`) }), AUTO_START_CHECK_MS);
  }
  if (!g.__sbDistillInterval) {
    // Checked per tick, not just once at boot, so a model added later takes effect without a
    // restart; wrapped, like every other interval here, so a thrown error never kills the timer.
    // Voided explicitly rather than left floating: resolving the provider now asks a local
    // runtime whether it holds the model, which is a round trip, and an unhandled rejection in
    // a timer callback would take the process with it.
    g.__sbDistillInterval = setInterval(() => {
      void (async () => {
        try {
          if (await getGistProvider()) distillSweepTick(db);
        } catch (err) {
          console.error("[distill] sweep failed:", err);
        }
      })();
    }, DISTILL_CHECK_MS);
  }
  if (!g.__sbDeskInterval) {
    // Queued rather than run here, so the sweep gets the worker's retry and its log line, and so
    // the "Refresh" button on `/desk` and this timer start exactly the same work.
    const desk = () => {
      try {
        enqueueJob(db, "desk", {});
      } catch (err) {
        console.error("[desk] could not queue the sweep:", err);
      }
    };
    setTimeout(desk, DESK_FIRST_MS).unref();
    g.__sbDeskInterval = setInterval(desk, DESK_CHECK_MS);
  }
  console.log("[boot] job worker started");
  return worker;
}

export function getWorker(): JobWorker | undefined {
  return g.__sbWorker;
}
