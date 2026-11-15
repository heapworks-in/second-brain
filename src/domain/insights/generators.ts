import { and, eq, gte, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { calendarEvents, observations, proposals, tasks } from "@/db/schema";
import { getHelperState } from "@/domain/activity/helper-state";
import { MINE } from "@/domain/tasks";
import { addDays, localDay } from "@/domain/activity";
import type { Insight, InsightGenerator } from "./types";

function count(db: { get: () => { n: number } | undefined }): number {
  return db.get()?.n ?? 0;
}

/**
 * Accessibility is the one permission macOS will not ask for on a helper's behalf, so it is the
 * one that silently stays off. Everything downstream of it -- window titles, and Slack, which is
 * read out of the desktop app's accessibility tree -- then runs perfectly and captures nothing.
 *
 * It is also voided by every helper rebuild, because an ad-hoc signed binary gives TCC nothing but
 * a file hash to key on, while System Settings carries on showing the entry with its switch on.
 * That is the specific trap this exists to call out.
 */
export const captureBlocked: InsightGenerator = (db) => {
  const helper = getHelperState(db);
  if (helper.permissions === null) {
    return [
      {
        id: "capture:helper-silent",
        severity: "blocked",
        headline: "The activity helper has never reported in",
        detail:
          "Nothing is capturing what you work on, and Slack is not being read. The helper may not be installed or may not be running.",
        href: "/settings",
        action: "Check the helper",
      },
    ];
  }
  if (helper.permissions.accessibility) return [];
  return [
    {
      id: "capture:no-accessibility",
      severity: "blocked",
      headline: "Accessibility is not granted, so nothing is being captured",
      detail:
        "Window titles and Slack both read through it. macOS pins the grant to the exact binary it was given, and every update replaces that binary -- so if you granted it before, an update has since voided it while the switch carries on looking on.",
      href: "/settings",
      action: "See how to grant it",
    },
  ];
};

/**
 * A calendar of nothing but all-day entries is a calendar with no meetings in it, and two features
 * read from it: preparing for a meeting, and recording one. Both had been shipped and neither had
 * ever fired, because every event in the database was a public holiday.
 */
export const calendarHasNoMeetings: InsightGenerator = (db, now) => {
  const since = addDays(localDay(now.toISOString()), -30);
  const total = count(
    db.select({ n: sql<number>`count(*)` }).from(calendarEvents).where(gte(calendarEvents.day, since)),
  );
  if (total === 0) return [];
  const real = count(
    db
      .select({ n: sql<number>`count(*)` })
      .from(calendarEvents)
      .where(and(gte(calendarEvents.day, since), eq(calendarEvents.allDay, 0), sql`${calendarEvents.attendees} > 0`)),
  );
  if (real > 0) return [];
  return [
    {
      id: "calendar:no-meetings",
      severity: "blocked",
      headline: `All ${total} calendar entries in the last month are all-day or have no attendees`,
      detail:
        "Nothing here is a meeting, so preparing for one and recording one both have nothing to work with. A work calendar probably is not connected -- holidays and birthdays come through on their own.",
      href: "/planner/meetings",
      action: "Look at what came through",
    },
  ];
};

/**
 * Tasks going in and never coming out. Not a nag about productivity: it usually means completing
 * happens somewhere else, which makes every count in the app -- overdue, stalled, the capacity
 * line -- quietly wrong.
 */
export const nothingEverCompleted: InsightGenerator = (db) => {
  const open = count(
    db.select({ n: sql<number>`count(*)` }).from(tasks).where(and(MINE, eq(tasks.status, "open"))),
  );
  const done = count(
    db.select({ n: sql<number>`count(*)` }).from(tasks).where(isNotNull(tasks.completedAt)),
  );
  if (done > 0 || open < 20) return [];
  return [
    {
      id: "tasks:none-completed",
      severity: "notable",
      headline: `${open} open tasks, and not one has ever been completed here`,
      detail:
        "Either finishing happens somewhere else, or these were imported and never worked. Every number that counts open work is reading from this, so it is worth knowing which.",
      href: "/planner",
      action: "Open the planner",
    },
  ];
};

/**
 * Slack's Activity view lists `@channel` announcements beside real mentions. On an announcements
 * channel they are nearly all of it -- which is correct behaviour and looks exactly like a broken
 * integration, so say so rather than leaving a silent desk to be interpreted.
 */
export const slackIsAllBroadcasts: InsightGenerator = (db) => {
  const total = count(db.select({ n: sql<number>`count(*)` }).from(observations).where(eq(observations.source, "slack")));
  if (total === 0) return [];
  const personal = count(
    db
      .select({ n: sql<number>`count(*)` })
      .from(observations)
      .where(and(eq(observations.source, "slack"), ne(observations.kind, "broadcast"))),
  );
  if (personal > 0) return [];
  return [
    {
      id: "slack:all-broadcasts",
      severity: "notable",
      headline: `All ${total} Slack messages read so far are @channel announcements`,
      detail:
        "A broadcast to a room is not somebody waiting on you, so none of them reach the desk. That is deliberate, and it means a quiet desk here is the right answer rather than a fault.",
      href: "/settings",
      action: "See how Slack is read",
    },
  ];
};

/**
 * The desk's own design named this as the thing to find out -- "if the desk is not something you
 * clear each morning, adding intake only makes a louder firehose". Nothing was measuring it, so
 * nobody found out for 810 sweeps.
 */
// `now` is unused: "never answered" is a count of decided rows, not a distance from today.
export const deskNeverAnswered: InsightGenerator = (db) => {
  const open = count(db.select({ n: sql<number>`count(*)` }).from(proposals).where(eq(proposals.state, "open")));
  if (open === 0) return [];
  const decided = count(
    db
      .select({ n: sql<number>`count(*)` })
      .from(proposals)
      .where(and(isNotNull(proposals.decidedAt), sql`${proposals.state} in ('accepted', 'dismissed')`)),
  );
  if (decided > 0) return [];
  return [
    {
      id: "desk:never-answered",
      severity: "notable",
      headline: `${open} ${open === 1 ? "decision is" : "decisions are"} waiting and none has ever been answered`,
      detail:
        "Every one of them is still open from the day it appeared. If the desk is not worth clearing, that is worth knowing now rather than after more sources are pointed at it.",
      href: "/desk",
      action: "Open the desk",
    },
  ];
};

/** Said once, when there is nothing wrong, so the page is not only ever bad news. */
export const everythingFlowing: InsightGenerator = (db) => {
  const helper = getHelperState(db);
  if (!helper.permissions?.accessibility) return [];
  const slack = count(db.select({ n: sql<number>`count(*)` }).from(observations).where(eq(observations.source, "slack")));
  if (slack === 0) return [];
  const linked = count(
    db.select({ n: sql<number>`count(*)` }).from(observations).where(isNull(observations.taskId)),
  );
  return [
    {
      id: "capture:flowing",
      severity: "good",
      headline: "Capture is running and Slack is being read",
      detail: `${slack} message${slack === 1 ? "" : "s"} read, ${linked} of them not yet answered here.`,
    },
  ];
};

export const GENERATORS: { name: string; run: InsightGenerator }[] = [
  { name: "capture_blocked", run: captureBlocked },
  { name: "calendar_has_no_meetings", run: calendarHasNoMeetings },
  { name: "slack_is_all_broadcasts", run: slackIsAllBroadcasts },
  { name: "nothing_ever_completed", run: nothingEverCompleted },
  { name: "desk_never_answered", run: deskNeverAnswered },
  { name: "everything_flowing", run: everythingFlowing },
];

const ORDER: Record<Insight["severity"], number> = { blocked: 0, notable: 1, good: 2 };

/**
 * Run the lot, worst first. One generator throwing must not cost the page the others: a missing
 * insight is a nuisance, a blank page because one query met data it did not expect is how a
 * feature gets switched off for good.
 */
export function collectInsights(db: Parameters<InsightGenerator>[0], now: Date, log: (m: string) => void = () => {}): Insight[] {
  const out: Insight[] = [];
  for (const { name, run } of GENERATORS) {
    try {
      out.push(...run(db, now));
    } catch (err) {
      log(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}
