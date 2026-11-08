import { inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import { tasks } from "@/db/schema";
import { addDays, getDay, getHelperState, localDay, topApps } from "@/domain/activity";
import { listBlocks } from "@/domain/blocks";
import { listContainers } from "@/domain/containers";
import { countInbox, listItems, parseMeta } from "@/domain/items";
import { deskPayload } from "@/domain/desk";
import { containerProgress, getTask } from "@/domain/tasks";
import { focusSummary, runningFocus } from "@/domain/focus";
import { getReview } from "@/domain/review";
import { goalsWithMeasure } from "@/domain/goals";
import { duePredictions } from "@/domain/predictions";
import { weeklyMeetingShare } from "@/domain/meetings/audit";
import { serializeFocusRun } from "./api";
import { daysBetween } from "./deadline";
import { plannerDay } from "./planner";
import { isoWeekday, weekStart } from "./week";
import type { HomeDTO, HomeItemDTO, ProjectCardDTO, RecentItemDTO } from "./dto";

/** How many project cards the right column holds. */
const MAX_PROJECTS = 6;
/** A deadline this close keeps a project in motion even with nothing open left on it. */
const IN_MOTION_DAYS = 14;
/** How many items Recent lists. */
const RECENT_LIMIT = 5;
/** How many apps or sites the activity line names. */
const TOP_ACTIVITY = 3;
/** How many timed things stand under the current one. */
const NEXT_LIMIT = 2;
/** Design §5.3: the review nudge starts on Friday, Monday being 1, and never earlier — it does
 * not grow more insistent as the week runs out, so nothing later than this ever reads it. */
const PROMPT_FROM_WEEKDAY = 5;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The one quiet line Home can carry toward the week's review. `due` holds from Friday morning
 * until the week has a review item, then never again that week — Design §5.3 is explicit that
 * this does not grow, repeat, or turn urgent as Sunday nears, so nothing here counts down or
 * escalates.
 */
function reviewPrompt(db: DB, date: string): HomeDTO["review"] {
  const week = weekStart(date);
  const review = getReview(db, week);
  return { due: isoWeekday(date) >= PROMPT_FROM_WEEKDAY && !review };
}

/** This week's meeting load, the same figure the audit's own headline reads off — reused
 * directly rather than re-derived, so the two can never disagree about the same week. */
function meetingLoad(db: DB, date: string): HomeDTO["meetingShare"] {
  return weeklyMeetingShare(db, weekStart(date));
}

/** Active goals nothing has closed against lately (`stalled`, already computed the same way the
 * Goals page and the Weekly Review's own Goals step read it) — named here, not just counted, so
 * the one thing worth a click is a click away rather than a trip through /goals to find which. */
function stalledGoals(db: DB, date: string): HomeDTO["stalledGoals"] {
  return goalsWithMeasure(db, { status: "active" }, date)
    .filter((g) => g.measure.stalled)
    .map((g) => ({ id: g.id, title: g.title }));
}

/** A session's end in the same local wall-clock spelling its start uses. */
function sessionEnd(startsAt: string, minutes: number): string {
  const at = new Date(Date.parse(startsAt) + minutes * 60_000);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * Every timed thing on the day, in start order: meetings the person is actually going to (or
 * has not said otherwise about), and the sessions of tasks still open. An all-day block holds no
 * hour, so it names no "now", and a session of a task already ticked off or dropped is not work
 * still to do.
 *
 * `m.decision` is the *effective* decision — this occurrence's own override, else its series',
 * else the calendar's own status — already resolved and batched once for the whole day by
 * `plannerMeetings`/`serializeMeetings` (`@/lib/api`), the same figure `freeMinutes` and
 * `busySpans` key off. Reading raw `m.status` here instead would let a meeting declined at the
 * series level still show as running "now", hiding whatever the scheduler correctly placed in
 * that freed hour — see `busySpans` (`@/domain/blocks/index.ts`) for the same rule applied to
 * the scheduler.
 */
function timedItems(db: DB, day: HomeDTO["day"], date: string): HomeItemDTO[] {
  const meetings: HomeItemDTO[] = day.meetings
    .filter((m) => !m.allDay && m.decision !== "not-going")
    .map((m) => ({
      kind: "meeting" as const,
      title: m.title,
      startsAt: m.startsAt,
      endsAt: m.endsAt,
      meetingId: m.id,
      ...(m.joinUrl ? { joinUrl: m.joinUrl } : {}),
    }));
  const blocks = listBlocks(db, { date });
  // One query for every session's task rather than one per session.
  const open = new Map(
    blocks.length === 0
      ? []
      : db
          .select({ id: tasks.id, title: tasks.title, status: tasks.status })
          .from(tasks)
          .where(inArray(tasks.id, [...new Set(blocks.map((b) => b.taskId))]))
          .all()
          .filter((t) => t.status === "open")
          .map((t) => [t.id, t.title] as const),
  );
  const sessions: HomeItemDTO[] = blocks
    .filter((b) => open.has(b.taskId))
    .map((b) => ({
      kind: "session" as const,
      title: open.get(b.taskId)!,
      startsAt: b.startsAt,
      endsAt: sessionEnd(b.startsAt, b.minutes),
      taskId: b.taskId,
      blockId: b.id,
    }));
  return [...meetings, ...sessions].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * What is happening now and what stands under it. A meeting in progress wins over a session in
 * progress — the meeting is where the person has to be — and `next` is the two soonest things
 * still to start, so whatever `now` holds can never appear under it as well.
 */
function nowAndNext(items: HomeItemDTO[], at: number): { now: HomeItemDTO | null; next: HomeItemDTO[] } {
  const running = items.filter((i) => Date.parse(i.startsAt) <= at && at < Date.parse(i.endsAt));
  // Of two things running at once the nearer end is the more pressing: a standup inside an
  // all-hands is what the next few minutes are actually about.
  const soonestEnd = (list: HomeItemDTO[]) => [...list].sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))[0];
  const now = soonestEnd(running.filter((i) => i.kind === "meeting")) ?? soonestEnd(running) ?? null;
  return { now, next: items.filter((i) => Date.parse(i.startsAt) > at).slice(0, NEXT_LIMIT) };
}

/** Nearest deadline first, the undated behind them, and the most recently touched first within a tie. */
function byDeadlineThenUpdated(a: ProjectCardDTO, b: ProjectCardDTO): number {
  if (a.deadline !== b.deadline) {
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline.localeCompare(b.deadline);
  }
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * The active projects in motion, at most six. "In motion" is something open to do on them —
 * or, with nothing open, a deadline close enough that having nothing open is itself the news.
 * An active project with neither is not moving, so it stays off a page about today.
 */
function projectCards(db: DB, today: string): ProjectCardDTO[] {
  const active = listContainers(db, { kind: "project", status: "active" });
  // The open count is what decides whether a project is in motion at all, so it is read for
  // every active one — still two grouped queries, not a pair per project.
  const progress = containerProgress(db, active.map((c) => c.id));
  return active
    .map((c) => {
      const p = progress.get(c.id);
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        open: p?.open ?? 0,
        done: p?.done ?? 0,
        nextTask: p?.nextTask ? { id: p.nextTask.id, title: p.nextTask.title } : null,
        deadline: c.deadline,
        updatedAt: c.updatedAt,
      } satisfies ProjectCardDTO;
    })
    // A deadline already past counts as near: the day it slipped is exactly when to see it.
    .filter((c) => c.open > 0 || (c.deadline !== null && daysBetween(today, c.deadline) <= IN_MOTION_DAYS))
    .sort(byDeadlineThenUpdated)
    .slice(0, MAX_PROJECTS);
}

/** The last five items touched; a meeting item carries what its chip says about it. */
function recentItems(db: DB): RecentItemDTO[] {
  return listItems(db, { limit: RECENT_LIMIT, orderBy: "updated" }).map((item) => {
    const row: RecentItemDTO = { id: item.id, type: item.type, title: item.title, updatedAt: item.updatedAt, status: item.status };
    if (item.type !== "meeting") return row;
    const meta = parseMeta(item);
    return { ...row, meeting: { hasTranscript: !!meta.transcript, hasSummary: !!meta.summary } };
  });
}

/**
 * Active time and the three things that took most of it; null until the helper has ever
 * reported. One line per app, never an app and its own pages as two, so the three add up to
 * something. An app whose time is mostly on the web is named by the site it spent it on.
 */
function activityToday(db: DB, date: string): HomeDTO["activity"] {
  if (getHelperState(db).lastSeen === null) return null;
  const report = getDay(db, date);
  const ms = (s: { startedAt: string; endedAt: string }) => Date.parse(s.endedAt) - Date.parse(s.startedAt);
  const awake = report.sessions.filter((s) => !s.afk);
  const top = topApps(
    awake.map((s) => ({ appId: s.appId, appName: s.appName, domain: s.domain, ms: ms(s) })),
    TOP_ACTIVITY,
  );
  return { activeMs: report.activeMs, top };
}

/**
 * Where the day stands, in one payload. The Planner's own day is reused whole — Home draws the
 * same plan rows and the same capacity line — and the counts are read back off it rather than
 * asked for again, so the figures and the rows under them can never disagree.
 */
export function homePayload(db: DB, now: Date): HomeDTO {
  const date = localDay(now.toISOString());
  // `now` goes through: without it the day's capacity reads the wall clock while `generatedAt`
  // and every other figure here read the argument, so one payload would describe two moments.
  const day = plannerDay(db, date, now);
  const { now: current, next } = nowAndNext(timedItems(db, day, date), now.getTime());
  // Reconciled here so `focus.running` is never stale, but which of a live run, a session or a
  // meeting wins the "Now" slot is decided once, client-side, in now-next.tsx — not repeated
  // here, where it would have nothing but a stale run to fall back on if the two ever disagreed.
  const running = runningFocus(db, now);
  const focusToday = focusSummary(db, { from: date, to: addDays(date, 1) }, now);
  return {
    date,
    today: date,
    // The moment the page is a picture of; Recent dates its rows against it rather than against
    // whatever the browser's clock says as it hydrates.
    generatedAt: now.toISOString(),
    day,
    counts: {
      planned: day.plan.filter((t) => t.status === "open").length,
      // The same meetings the capacity line measures: a declined one takes none of the day.
      meetings: day.meetings.filter((m) => !m.allDay && m.status !== "declined").length,
      // The dock's badge count, called rather than counted again.
      inbox: countInbox(db),
      // Home says how many decisions are waiting and nothing else about them: the desk is a
      // place you go to, and a card answered from here would make Home the deciding surface
      // that `/desk` exists to be instead.
      desk: deskPayload(db, now).open,
    },
    now: current,
    next,
    projects: projectCards(db, date),
    recent: recentItems(db),
    activity: activityToday(db, date),
    focus: {
      minutes: focusToday.minutes,
      running: running ? serializeFocusRun(running, running.taskId != null ? (getTask(db, running.taskId)?.title ?? "") : "") : null,
    },
    review: reviewPrompt(db, date),
    meetingShare: meetingLoad(db, date),
    stalledGoals: stalledGoals(db, date),
    // The log's nag. Counted here rather than on `/log` so it is seen without being looked for:
    // an unresolved prediction nobody goes back to is what turns the log into a diary.
    duePredictions: duePredictions(db, date).length,
  };
}
