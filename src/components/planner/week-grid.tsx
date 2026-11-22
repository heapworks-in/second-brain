"use client";

import { useEffect, useState, type DragEvent } from "react";
import Link from "next/link";
import type { ActivityMeetingDTO, PlannerWeekDayDTO, PlanTaskDTO } from "@/lib/dto";
import { capacityTone, formatMinutes, overBasis, type CapacityTone } from "@/lib/capacity";
import { formatClock, todayLocal } from "../activity/format";
import { blockEnd, blocksOn } from "./block-math";
import { layoutBlocks, type TimelineMeeting } from "./timeline-layout";

/**
 * The week as a calendar, not as seven lists.
 *
 * What was here before put each day in its own card and stacked the day's contents inside it:
 * the date, a capacity figure, a row per meeting, and a full task row per thing due. Across
 * seven columns that is seven narrow cards about 200px wide, and a task row built for the width
 * of a page arrives in one truncated to about ten characters -- a title clipped to "Build a...",
 * its chips clipped to "G... +3", and a Focus button taking more room than either. The week it
 * described was also unreadable as a week: nothing was placed in time, so a Tuesday with one
 * meeting at nine and a Tuesday with one at five looked exactly alike, and six empty days were
 * six empty boxes rather than six free days.
 *
 * So the hours run down the side and the days run across, which is the one layout that answers
 * the question a week is opened to ask: where is there room. Meetings and planned sessions are
 * drawn where they actually fall, a day with nothing in it is visibly empty rather than an empty
 * container, and anything without a time -- an all-day event, something merely due -- sits in a
 * rail above the grid instead of pretending to a position in it.
 *
 * Reading, not editing. Placing and resizing a session is the day view's job, where a column is
 * wide enough to grab: the same affordance across seven 150px columns is a precision mouse game.
 * The one edit kept is the one that was already here -- drag a task onto a day to move its due
 * date -- because that is a week-shaped action.
 */

/** Three fifths of a pixel per minute: a ten-hour day is 360px, and seven of them fit a screen
 * beside each other without the page itself having to scroll. */
const PX_PER_MIN = 0.6;
const DEFAULT_START = 8;
const DEFAULT_END = 19;
const TICK_MS = 60_000;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Chips in a day's rail before it says "+n" instead. A rail is a glance, not a list. */
const RAIL_CAP = 3;

/** The load bar's fill. The text tones this mirrors (`CAPACITY_TONE_CLASS`) are foreground
 * colours, and only some of them have a background of the same name -- so the mapping is
 * written out rather than derived by rewriting "text-" to "bg-". */
const BAR_TONE: Record<CapacityTone, string> = { ok: "bg-violet", warn: "bg-warn", danger: "bg-danger" };

export interface WeekGridProps {
  days: PlannerWeekDayDTO[];
  today: string;
  /** The week's one drift multiplier, for the load bar's tone -- the same figure the day view
   * judges a day by, so a column here cannot read as calm on the bare plan alone. */
  drift: number | null;
  workHours?: string;
  onOpenMeeting: (id: number) => void;
  /** A task dragged from one day onto another. */
  onDropTask: (taskId: number, date: string) => void;
  /** The drag's own type, so a column only takes a task dragged from this week. */
  taskMime: string;
}

interface Placed {
  key: string;
  top: number;
  height: number;
  col: number;
  cols: number;
  kind: "meeting" | "session";
  title: string;
  from: string;
  to: string;
  meetingId?: number;
}

function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAY_SHORT[new Date(y, m - 1, d).getDay()];
}

/** A session, in the shape `layoutBlocks` places meetings in, so one pass lays out both and a
 * meeting overlapping a session shares the width with it rather than hiding underneath. */
function sessionSpans(tasks: PlanTaskDTO[], date: string): { span: TimelineMeeting; task: PlanTaskDTO }[] {
  return tasks.flatMap((task) =>
    blocksOn(task, date).map((block) => ({
      span: { id: block.id, startsAt: block.startsAt, endsAt: blockEnd(block) },
      task,
    })),
  );
}

/**
 * The hours the whole grid covers.
 *
 * One range for seven columns, never one each: columns whose hours differ cannot be read across,
 * which is the only thing a week view is for. It is the working day, widened by whatever falls
 * outside it anywhere in the week.
 */
export function weekHours(days: PlannerWeekDayDTO[], workHours?: string): { dayStart: number; dayEnd: number } {
  const parsed = workHours?.match(/^(\d{1,2}):\d{2}-(\d{1,2}):\d{2}$/);
  let dayStart = parsed ? Number(parsed[1]) : DEFAULT_START;
  let dayEnd = parsed ? Number(parsed[2]) : DEFAULT_END;
  for (const day of days) {
    for (const at of [
      ...day.meetings.filter((m) => !m.allDay).flatMap((m) => [m.startsAt, m.endsAt]),
      ...sessionSpans(day.plan, day.date).flatMap(({ span }) => [span.startsAt, span.endsAt]),
    ]) {
      const d = new Date(at);
      if (Number.isNaN(d.getTime())) continue;
      dayStart = Math.min(dayStart, d.getHours());
      dayEnd = Math.max(dayEnd, d.getMinutes() > 0 ? d.getHours() + 1 : d.getHours());
    }
  }
  return { dayStart, dayEnd: Math.max(dayEnd, dayStart + 1) };
}

function place(day: PlannerWeekDayDTO, bounds: { dayStart: number; dayEnd: number }): Placed[] {
  const timed = day.meetings.filter((m) => !m.allDay);
  const sessions = sessionSpans(day.plan, day.date);
  // Negative ids for sessions so the two sets cannot collide in one layout pass.
  const spans: TimelineMeeting[] = [
    ...timed.map((m) => ({ id: m.id, startsAt: m.startsAt, endsAt: m.endsAt })),
    ...sessions.map(({ span }, i) => ({ id: -(i + 1), startsAt: span.startsAt, endsAt: span.endsAt })),
  ];
  const meetingById = new Map(timed.map((m) => [m.id, m]));
  return layoutBlocks(spans, bounds).flatMap<Placed>((b) => {
    const base = { top: b.top, height: b.height, col: b.col, cols: b.cols };
    if (b.id < 0) {
      const entry = sessions[-b.id - 1];
      if (!entry) return [];
      return [{
        ...base,
        key: `s${entry.span.id}`,
        kind: "session" as const,
        title: entry.task.title,
        from: entry.span.startsAt,
        to: entry.span.endsAt,
      }];
    }
    const meeting = meetingById.get(b.id);
    if (!meeting) return [];
    return [{ ...base, key: `m${meeting.id}`, kind: "meeting" as const, title: meeting.title, from: meeting.startsAt, to: meeting.endsAt, meetingId: meeting.id }];
  });
}

/** How full a day is, 0 to 1, for the hairline bar under its date. */
function load(day: PlannerWeekDayDTO, today: string): number {
  // A day already over is a ratio against the window it had; today and anything ahead against
  // what is still left of it. The same distinction the old column figure drew, and the reason a
  // past day does not read as infinitely over.
  const denom = day.date < today ? day.capacity.freeMinutes : day.capacity.leftTodayMinutes;
  if (denom <= 0) return day.capacity.plannedMinutes > 0 ? 1 : 0;
  return Math.min(1, day.capacity.plannedMinutes / denom);
}

export function WeekGrid({ days, today, drift, workHours, onOpenMeeting, onDropTask, taskMime }: WeekGridProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const bounds = weekHours(days, workHours);
  const minutes = (bounds.dayEnd - bounds.dayStart) * 60;
  const hours = Array.from({ length: bounds.dayEnd - bounds.dayStart + 1 }, (_, i) => bounds.dayStart + i);

  const nowOffset = now.getHours() * 60 + now.getMinutes() - bounds.dayStart * 60;
  const showNow = days.some((d) => d.date === todayLocal(now)) && nowOffset >= 0 && nowOffset <= minutes;

  function onDrop(e: DragEvent<HTMLDivElement>, date: string) {
    e.preventDefault();
    const raw = e.dataTransfer.getData(taskMime);
    if (raw) onDropTask(Number(raw), date);
  }

  return (
    <section aria-label="Week" className="flex flex-col">
      <div className="flex">
        {/* The gutter's own header, empty, so the hour labels below line up under nothing
          * rather than under Monday. */}
        <div className="w-12 shrink-0" aria-hidden />
        {days.map((day) => {
          const isToday = day.date === today;
          const rail: { key: string; label: string; title: string; onClick?: () => void; href?: string }[] = [
            ...day.meetings.filter((m) => m.allDay).map((m: ActivityMeetingDTO) => ({
              key: `a${m.id}`, label: m.title, title: m.title, onClick: () => onOpenMeeting(m.id),
            })),
            ...day.due.map((t) => ({ key: `d${t.id}`, label: t.title, title: `Due: ${t.title}`, href: `/tasks/${t.id}` })),
          ];
          const tone = capacityTone(overBasis({ ...day.capacity, drift }), day.date < today ? day.capacity.freeMinutes : day.capacity.leftTodayMinutes);
          return (
            <div key={day.date} className="flex-1 min-w-0 px-1.5 flex flex-col gap-1.5 pb-2">
              <span className="flex items-baseline gap-1.5">
                <span className={`font-doc text-[20px] leading-none ${isToday ? "text-violet-bright" : "text-fg"}`}>
                  {Number(day.date.slice(8, 10))}
                </span>
                <span className={`micro ${isToday ? "!text-violet-bright" : ""}`}>{weekdayOf(day.date)}</span>
              </span>
              {/* The load as a bar rather than a figure. Seven copies of "0m / 9h" was six lines
                * of arithmetic around the one day that had anything in it; a bar is read without
                * being parsed, and a day with nothing planned draws nothing at all. */}
              <span className="h-[3px] rounded-full bg-surface-sunken overflow-hidden" role="img"
                aria-label={day.working ? `${formatMinutes(day.capacity.plannedMinutes)} planned` : "Not a working day"}>
                {day.working && day.capacity.plannedMinutes > 0 && (
                  <span
                    className={`block h-full rounded-full ${BAR_TONE[tone]}`}
                    style={{ width: `${Math.round(load(day, today) * 100)}%` }}
                    title={`${formatMinutes(day.capacity.plannedMinutes)} planned`}
                  />
                )}
              </span>
              {rail.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {rail.slice(0, RAIL_CAP).map((r) =>
                    r.href ? (
                      <Link key={r.key} href={r.href} title={r.title}
                        className="focus-ring truncate rounded-sm px-1 py-0.5 text-[11.5px] text-fg-muted hover:text-fg hover:bg-layer-2 transition-colors">
                        {r.label}
                      </Link>
                    ) : (
                      <button key={r.key} type="button" onClick={r.onClick} title={r.title}
                        className="focus-ring truncate rounded-sm px-1 py-0.5 text-left text-[11.5px] text-fg-muted hover:text-fg hover:bg-layer-2 transition-colors">
                        {r.label}
                      </button>
                    ),
                  )}
                  {rail.length > RAIL_CAP && (
                    <Link href={`/planner?date=${day.date}`} className="focus-ring rounded-sm px-1 text-[11px] text-fg-faint hover:text-violet-bright transition-colors">
                      {rail.length - RAIL_CAP} more
                    </Link>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="relative flex" style={{ height: minutes * PX_PER_MIN }} data-testid="week-grid">
        {/* Hour lines first and full width, so every column is read against the same rules. */}
        {hours.map((hour) => (
          <div key={hour} className="absolute left-0 right-0 flex items-start gap-2 pointer-events-none" style={{ top: (hour - bounds.dayStart) * 60 * PX_PER_MIN }}>
            <span className="font-mono text-[10.5px] text-fg-faint w-12 shrink-0 -translate-y-1.5 text-right pr-2">
              {String(hour % 24).padStart(2, "0")}
            </span>
            <span className="flex-1 border-t border-hairline opacity-50" aria-hidden />
          </div>
        ))}

        <div className="w-12 shrink-0" aria-hidden />
        {days.map((day) => {
          const isToday = day.date === today;
          return (
            <div
              key={day.date}
              data-testid={`week-day-${day.date}`}
              className={`relative flex-1 min-w-0 border-l border-hairline ${isToday ? "bg-violet-dim/25" : day.working ? "" : "bg-surface-sunken/70"}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(e, day.date)}
            >
              {place(day, bounds).map((b) => {
                const width = `calc(${100 / b.cols}% - 3px)`;
                const left = `calc(${(b.col * 100) / b.cols}% + 2px)`;
                const style = { top: b.top * PX_PER_MIN, height: Math.max(b.height * PX_PER_MIN, 14), width, left };
                const when = `${formatClock(b.from)}–${formatClock(b.to)}`;
                if (b.kind === "meeting") {
                  return (
                    <button
                      key={b.key}
                      type="button"
                      onClick={() => b.meetingId !== undefined && onOpenMeeting(b.meetingId)}
                      title={`${b.title}, ${when}`}
                      style={style}
                      className="focus-ring absolute overflow-hidden rounded-[5px] border border-hairline-strong bg-layer-2 px-1.5 py-0.5 text-left hover:bg-layer-3 transition-colors"
                    >
                      <span className="block truncate text-[11.5px] leading-tight text-fg">{b.title}</span>
                      <span className="block truncate font-mono text-[10px] text-fg-faint">{formatClock(b.from)}</span>
                    </button>
                  );
                }
                return (
                  // A session is mine and a meeting is somebody else's, so they are told apart by
                  // fill rather than by a label: the week is read at a glance or not at all.
                  <Link
                    key={b.key}
                    href={`/planner?date=${day.date}`}
                    title={`${b.title}, ${when}`}
                    style={style}
                    className="focus-ring absolute overflow-hidden rounded-[5px] border-l-2 border-violet bg-violet-dim/60 px-1.5 py-0.5 hover:bg-violet-dim transition-colors"
                  >
                    <span className="block truncate text-[11.5px] leading-tight text-fg">{b.title}</span>
                    <span className="block truncate font-mono text-[10px] text-violet-bright">{formatClock(b.from)}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}

        {showNow && (
          <div className="absolute left-12 right-0 flex items-center pointer-events-none" style={{ top: nowOffset * PX_PER_MIN }} aria-hidden>
            <span className="w-1.5 h-1.5 rounded-full bg-violet-bright -ml-0.5" />
            <span className="flex-1 border-t border-violet-bright/70" />
          </div>
        )}
      </div>
    </section>
  );
}
