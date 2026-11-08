import { and, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import { calendarEvents, meetingSeriesDecisions } from "@/db/schema";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

/** "in 50 minutes", "in 2 hours" — the only number on the card that moves between sweeps. */
function inWords(minutes: number): string {
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  return hours < 1.6 ? "in an hour" : `in ${hours.toFixed(hours < 3 ? 1 : 0).replace(".0", "")} hours`;
}

function names(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A meeting with other people in it, starting soon, with nothing written down against it.
 *
 * Deliberately narrow. "No note" means no linked item at all -- not a short one, not one without
 * an agenda -- because the app cannot tell a thin note from a sufficient one, and a card that
 * fires on a judgement it cannot make is a card that gets dismissed until the kind sinks.
 *
 * A meeting already declined is skipped: there is nothing to prepare for something you are not
 * going to. One-person holds, all-day blocks and anything already captured are skipped for the
 * same reason -- none of them is a conversation to be ready for.
 */
export const meetingUnprepared: Generator = (db, now) => {
  const hours = threshold(db, "desk.meetingPrepHours");
  const from = now.toISOString();
  const to = new Date(now.getTime() + hours * 3_600_000).toISOString();

  const rows = db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      startsAt: calendarEvents.startsAt,
      attendees: calendarEvents.attendees,
      attendeeNames: calendarEvents.attendeeNames,
      organizer: calendarEvents.organizer,
      seriesId: calendarEvents.seriesId,
      containerId: calendarEvents.containerId,
      seriesDecision: meetingSeriesDecisions.decision,
      decision: calendarEvents.decision,
    })
    .from(calendarEvents)
    .leftJoin(meetingSeriesDecisions, eq(meetingSeriesDecisions.seriesId, calendarEvents.seriesId))
    .where(
      and(
        gt(calendarEvents.startsAt, from),
        lte(calendarEvents.startsAt, to),
        gt(calendarEvents.attendees, 1),
        eq(calendarEvents.allDay, 0),
        isNull(calendarEvents.itemId),
        ne(calendarEvents.status, "declined"),
        // Null means "no call of my own", which is not the same as going.
        or(isNull(calendarEvents.decision), ne(calendarEvents.decision, "not-going")),
      ),
    )
    .orderBy(sql`${calendarEvents.startsAt} asc`)
    .all();

  return rows
    .filter((r) => r.seriesDecision !== "not-going" || r.decision === "going")
    .map((r) => {
      const minutes = (Date.parse(r.startsAt) - now.getTime()) / 60_000;
      const people = names(r.attendeeNames);
      const who = people.length > 0 ? people.slice(0, 3).join(", ") + (people.length > 3 ? ` +${people.length - 3}` : "") : `${r.attendees} people`;
      return {
        kind: "meeting_unprepared" as const,
        source: "meeting" as const,
        sourceRef: `event:${r.id}`,
        title: `${r.title} starts ${inWords(minutes)}`,
        detail: `${who}. Nothing written down against it yet.`,
        payload: {
          eventId: r.id,
          title: r.title,
          startsAt: r.startsAt,
          containerId: r.containerId,
          attendeeNames: people,
          organizer: r.organizer,
        },
        // The nearer it starts, the less time there is to do anything about it.
        urgency: 1 - Math.max(0, minutes) / (hours * 60),
      };
    });
};
