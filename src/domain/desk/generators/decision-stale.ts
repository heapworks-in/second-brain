import { desc, eq, sql } from "drizzle-orm";
import { calendarEvents, meetingSeriesDecisions } from "@/db/schema";
import { threshold } from "../thresholds";
import type { Generator } from "../types";

const DAY_MS = 86_400_000;

/** What the standing call reads as on the card, in the words the buttons will use. */
const CALLS = {
  going: { was: "going to", ask: "Still going?" },
  "not-going": { was: "skipping", ask: "Still skipping it?" },
  maybe: { was: "undecided about", ask: "Decided yet?" },
} as const;

/**
 * A standing call on a recurring meeting that nothing has confirmed in months.
 *
 * This is the one generator that is about the app's own memory rather than about work. A decision
 * to skip a weekly meeting, taken in March, is presented in November exactly as confidently as
 * one taken yesterday -- and the app has no way of knowing which, because trust was never stored
 * as a property of the last check. `last_verified` is that property; this card is how it gets set.
 *
 * Accepting is a reaffirmation and nothing else: no `DELETE`, ever. A call that has genuinely
 * stopped applying is dismissed, which leaves the record and the refusal both readable, and that
 * is the strongest claim an archive should make about something a person decided.
 */
export const decisionStale: Generator = (db, now) => {
  const days = threshold(db, "desk.decisionStaleDays");
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();

  const rows = db
    .select({
      seriesId: meetingSeriesDecisions.seriesId,
      decision: meetingSeriesDecisions.decision,
      note: meetingSeriesDecisions.note,
      decidedAt: meetingSeriesDecisions.decidedAt,
      lastVerified: meetingSeriesDecisions.lastVerified,
    })
    .from(meetingSeriesDecisions)
    // A decision never checked is as old as the day it was taken: that is what the fallback means.
    .where(sql`coalesce(${meetingSeriesDecisions.lastVerified}, ${meetingSeriesDecisions.decidedAt}) < ${cutoff}`)
    .all();

  return rows.flatMap((r) => {
    // The series' own title, from whichever occurrence the calendar still holds. No occurrence
    // means the series is gone from the calendar entirely, and a card naming nothing is useless.
    const occurrence = db
      .select({ title: calendarEvents.title, startsAt: calendarEvents.startsAt })
      .from(calendarEvents)
      .where(eq(calendarEvents.seriesId, r.seriesId))
      .orderBy(desc(calendarEvents.startsAt))
      .limit(1)
      .get();
    if (!occurrence) return [];

    const since = r.lastVerified ?? r.decidedAt;
    const age = Math.floor((now.getTime() - Date.parse(since)) / DAY_MS);
    const call = CALLS[r.decision];
    return [
      {
        kind: "decision_stale" as const,
        source: "decision" as const,
        sourceRef: `series:${r.seriesId}`,
        title: `${call.ask} — ${occurrence.title}`,
        detail: r.note.trim()
          ? `You have been ${call.was} this for ${age} days: "${r.note.trim()}"`
          : `You have been ${call.was} this for ${age} days, unchecked since.`,
        payload: { seriesId: r.seriesId, decision: r.decision, title: occurrence.title, since, ageDays: age },
        // Grows past the threshold and saturates at twice it: a decision three years stale is not
        // more urgent than one six months stale, it is the same kind of overdue.
        urgency: Math.min(1, (age - days) / days + 0.1),
      },
    ];
  });
};
