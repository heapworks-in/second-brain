"use client";

import Link from "next/link";
import type { HomeDTO, PlannerDayDTO } from "@/lib/dto";
import { count } from "../planner/open-meeting";
import { CapacityLine } from "../planner/capacity-line";
import { DateHeader } from "../planner/date-header";
import { formatDuration } from "../activity/format";
import { formatMinutes } from "@/lib/capacity";

/** A figure worth a number, or the words for a day that has none of it. */
function figure(n: number, some: string, none: string): string {
  return n === 0 ? none : some;
}

/** Where each figure leads, in the order spec §2 reads them out. */
function figures(counts: HomeDTO["counts"]): { href: string; label: string }[] {
  return [
    { href: "/planner", label: figure(counts.planned, `${counts.planned} planned`, "Nothing planned") },
    { href: "/planner/meetings", label: figure(counts.meetings, count(counts.meetings, "meeting"), "No meetings") },
    { href: "/inbox", label: figure(counts.inbox, `${counts.inbox} in the inbox`, "Inbox clear") },
    // One line, never the cards themselves. Zero drops off entirely rather than reading "Desk
    // clear" beside four other figures: a clear desk is not a figure, it is the absence of one.
    ...(counts.desk > 0 ? [{ href: "/desk", label: `${counts.desk} on the desk` }] : []),
  ];
}

interface Props {
  day: PlannerDayDTO;
  counts: HomeDTO["counts"];
  focus: HomeDTO["focus"];
  review: HomeDTO["review"];
  meetingShare: HomeDTO["meetingShare"];
  stalledGoals: HomeDTO["stalledGoals"];
  duePredictions: HomeDTO["duePredictions"];
  onHours: (workHours: string) => void;
  onWorkingDays: (workingDays: number[]) => void;
}

/** Whether the week has anything worth its own quiet line under today's figures. */
function hasWeekLine(meetingShare: HomeDTO["meetingShare"], stalledGoals: HomeDTO["stalledGoals"], review: HomeDTO["review"], duePredictions: number): boolean {
  return meetingShare.minutes > 0 || stalledGoals.length > 0 || review.due || duePredictions > 0;
}

/**
 * The day's own header: the Planner's numeral and weekday, its capacity line with the hours
 * chip, and the three figures under them. Home is always today, so the header carries no
 * arrows — the figures are the way out of it instead.
 *
 * Today's figures and the week's own are two separate lines, not one growing list: a count that
 * resets tonight and one that only the audit or the review resets read as different kinds of
 * fact, and blurring them into a single row is what made the header read as a ticker.
 *
 * Design §5.3: from Friday, a week with no review yet adds one quiet line under the figures —
 * no badge, no colour, no count, nothing that grows more insistent as Sunday nears. Once the
 * week has a review it renders nothing at all, not even a tick, because this is a nudge and the
 * research behind it is explicit that the nagging version is the one people turn off.
 */
export function TopBand({ day, counts, focus, review, meetingShare, stalledGoals, duePredictions, onHours, onWorkingDays }: Props) {
  return (
    <header className="flex flex-col gap-2">
      <DateHeader
        date={day.date}
        unit="day"
        summary={
          <CapacityLine capacity={day.capacity} meetings={counts.meetings} onHours={onHours} onWorkingDays={onWorkingDays} quiet />
        }
      />
      <ul className="list-none m-0 p-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-fg-muted">
        {figures(counts).map((f) => (
          <li key={f.href}>
            <Link href={f.href} className="focus-ring rounded-sm hover:text-fg transition-colors duration-150">
              {f.label}
            </Link>
          </li>
        ))}
        {/* What the day has cost so far — nowhere of its own to lead to yet, so it is read, not linked. */}
        <li>{focus.minutes === 0 ? "Nothing focused yet" : `${formatDuration(focus.minutes * 60_000)} focused`}</li>
      </ul>
      {hasWeekLine(meetingShare, stalledGoals, review, duePredictions) && (
        <ul className="list-none m-0 p-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-fg-faint">
          {/* This week's meeting load, the audit's own figure — reused, not re-derived, so the
            * two can never disagree about the same week. Zero reads as a fact, not a nudge: a
            * light meeting week is not something to fix, so it drops off this line entirely. */}
          {meetingShare.minutes > 0 && (
            <li>
              <Link href="/meetings/audit" className="focus-ring rounded-sm hover:text-fg transition-colors duration-150">
                {formatMinutes(meetingShare.minutes)} in meetings this week
              </Link>
            </li>
          )}
          {stalledGoals.length > 0 && (
            <li>
              <Link href="/goals" className="focus-ring rounded-sm hover:text-fg transition-colors duration-150">
                {count(stalledGoals.length, "goal")} stalled
              </Link>
            </li>
          )}
          {review.due && (
            <li>
              <Link href="/review" className="focus-ring rounded-sm hover:text-fg transition-colors duration-150">
                Review your week
              </Link>
            </li>
          )}
          {/* A call whose answer is already knowable. Said plainly, because the honest figures
            * the log produces depend entirely on these being gone back to. */}
          {duePredictions > 0 && (
            <li>
              <Link href="/log" className="focus-ring rounded-sm hover:text-fg transition-colors duration-150">
                {count(duePredictions, "call")} to score
              </Link>
            </li>
          )}
        </ul>
      )}
    </header>
  );
}
