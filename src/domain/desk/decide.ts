import { and, eq, gte } from "drizzle-orm";
import type { DB } from "@/db/client";
import { dailyPlanEntries, meetingSeriesDecisions, proposals, type Proposal } from "@/db/schema";
import { createItem, deleteItem, fileItem, getItem } from "@/domain/items";
import { acceptMeetingAction, markActionAccepted } from "@/domain/meetings/actions";
import { addToPlan, removeFromPlan } from "@/domain/plan";
import { deleteTask, getTask, updateTask } from "@/domain/tasks";
import { formatMinutes } from "@/lib/capacity";
import { localDay } from "@/lib/time";
import { threshold } from "./thresholds";

export type Decision = "accept" | "snooze" | "dismiss";

export interface Decided {
  proposal: Proposal;
  /** What happened, in the past tense of the button that was pressed: "Re-estimated to 1h 30m". */
  label: string;
  /** Where the answer landed, when there is somewhere to go and look at it. */
  href?: string;
}

/** Thrown for a proposal that is not there, or has already been answered. */
export class DeskError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function payloadOf<T>(proposal: Proposal): T {
  try {
    return JSON.parse(proposal.payload) as T;
  } catch {
    return {} as T;
  }
}

/**
 * What accepting commits, per kind, and how to put it back.
 *
 * Every arm calls the same domain functions the rest of the app does -- `fileItem`,
 * `updateTask`, `removeFromPlan`, `acceptMeetingAction` -- rather than writing its own SQL, so a
 * proposal can never commit something by a route no other surface takes. The `undo` it returns
 * is the reverse of exactly what it did and nothing more: it is called by a person who pressed
 * the wrong button eight seconds ago, not by a migration.
 *
 * `prediction_due` commits nothing. The answer to a prediction is a number or a yes, which only
 * the person has, so accepting means "take me to the place that asks" -- and the undo is simply
 * that the proposal goes back on the desk.
 */
function commit(db: DB, proposal: Proposal, now: Date): { label: string; href?: string; undo: () => void } {
  switch (proposal.kind) {
    case "meeting_unprepared": {
      const p = payloadOf<{ eventId: number; title: string; startsAt: string; containerId: number | null; attendeeNames: string[]; organizer: string }>(proposal);
      const who = (p.attendeeNames ?? []).join(", ");
      const note = createItem(db, {
        type: "note",
        title: `Prep: ${p.title}`,
        // A heading and the facts, no prompts: a template of questions nobody answers is worse
        // than an empty note, because it makes the note look written.
        body: [`${p.title} — ${p.startsAt}`, who && `With: ${who}`, p.organizer && `Called by: ${p.organizer}`].filter(Boolean).join("\n"),
        containerId: p.containerId,
      });
      return {
        label: `Started a prep note for ${p.title}`,
        href: `/items/${note.id}`,
        undo: () => deleteItem(db, note.id),
      };
    }

    case "decision_stale": {
      const p = payloadOf<{ seriesId: string }>(proposal);
      const before = db.select().from(meetingSeriesDecisions).where(eq(meetingSeriesDecisions.seriesId, p.seriesId)).get();
      if (!before) throw new DeskError("That decision is no longer there", 404);
      db.update(meetingSeriesDecisions)
        .set({ lastVerified: now.toISOString(), confidence: 1 })
        .where(eq(meetingSeriesDecisions.seriesId, p.seriesId))
        .run();
      return {
        label: "Reaffirmed",
        undo: () =>
          void db
            .update(meetingSeriesDecisions)
            .set({ lastVerified: before.lastVerified, confidence: before.confidence })
            .where(eq(meetingSeriesDecisions.seriesId, p.seriesId))
            .run(),
      };
    }

    case "task_overrun": {
      const p = payloadOf<{ taskId: number; proposedMinutes: number }>(proposal);
      const before = getTask(db, p.taskId);
      if (!before) throw new DeskError("That task is no longer there", 404);
      updateTask(db, p.taskId, { estimateMinutes: p.proposedMinutes });
      return {
        label: `Re-estimated to ${formatMinutes(p.proposedMinutes)}`,
        undo: () => void updateTask(db, p.taskId, { estimateMinutes: before.estimateMinutes }),
      };
    }

    case "task_stalled": {
      const p = payloadOf<{ taskId: number }>(proposal);
      const today = localDay(now.toISOString());
      // Today and anything already planned beyond it. Yesterday's entries are history: a plan
      // that has been and gone is a record of what was intended, and editing it rewrites the past.
      const upcoming = db
        .select({ date: dailyPlanEntries.date })
        .from(dailyPlanEntries)
        .where(and(eq(dailyPlanEntries.taskId, p.taskId), gte(dailyPlanEntries.date, today)))
        .all()
        .map((r) => r.date);
      if (upcoming.length === 0) throw new DeskError("That task is not on any plan from today on", 400);
      for (const date of upcoming) removeFromPlan(db, date, p.taskId);
      return {
        label: upcoming.length === 1 ? "Taken off today's plan" : `Taken off ${upcoming.length} days' plans`,
        undo: () => {
          for (const date of upcoming) addToPlan(db, date, p.taskId);
        },
      };
    }

    case "commitment_owed": {
      const p = payloadOf<{ taskId: number; personName: string }>(proposal);
      const today = localDay(now.toISOString());
      const task = getTask(db, p.taskId);
      if (!task) throw new DeskError("That task is no longer there", 404);
      // Already on today's plan is not an error worth stopping for -- the answer the card asks
      // for is "today holds this", and it does. The undo then has nothing to take back.
      const already = db
        .select({ id: dailyPlanEntries.id })
        .from(dailyPlanEntries)
        .where(and(eq(dailyPlanEntries.taskId, p.taskId), eq(dailyPlanEntries.date, today)))
        .get();
      if (!already) addToPlan(db, today, p.taskId);
      return {
        label: already ? "Already on today's plan" : `Planned for today${p.personName ? ` for ${p.personName}` : ""}`,
        href: "/planner",
        undo: () => {
          if (!already) removeFromPlan(db, today, p.taskId);
        },
      };
    }

    case "prediction_due": {
      const p = payloadOf<{ predictionId: number }>(proposal);
      return { label: "Opened to resolve", href: `/log?resolve=${p.predictionId}`, undo: () => {} };
    }

    case "capture_unfiled": {
      const p = payloadOf<{ itemId: number; containerId: number; containerName: string }>(proposal);
      const before = getItem(db, p.itemId);
      if (!before) throw new DeskError("That capture is no longer there", 404);
      fileItem(db, p.itemId, p.containerId);
      return {
        label: `Filed in ${p.containerName}`,
        href: `/items/${p.itemId}`,
        undo: () => void fileItem(db, p.itemId, before.containerId),
      };
    }

    case "commitment_unbooked": {
      const p = payloadOf<{ itemId: number; index: number; title: string }>(proposal);
      const { task, created } = acceptMeetingAction(db, p.itemId, p.index, p.title);
      return {
        label: `Booked "${task.title}"`,
        href: `/items/${p.itemId}`,
        undo: () => {
          // Only what this press created: an action already booked from the meeting page must
          // not lose its task because the desk card was undone.
          if (created) deleteTask(db, task.id);
          markActionAccepted(db, p.itemId, p.index, !created);
        },
      };
    }
  }
}

/**
 * Answer one proposal.
 *
 * Accepting commits and then marks the row, in that order: a commit that throws must leave the
 * proposal open rather than marking it answered, because a card that has vanished and done
 * nothing is the one failure nobody can recover from by themselves.
 *
 * Dismissing writes nothing but the row. The downweighting people expect from "Never" is not an
 * action taken here -- it is `dismissRate` reading this row the next time the kind is ranked,
 * which is why a dismissal can be undone by hand and the lesson goes with it.
 */
export function decideProposal(db: DB, id: number, decision: Decision, now: Date): Decided {
  const proposal = db.select().from(proposals).where(eq(proposals.id, id)).get();
  if (!proposal) throw new DeskError(`Proposal ${id} not found`, 404);
  if (proposal.state !== "open") throw new DeskError("That has already been answered", 409);

  const at = now.toISOString();

  if (decision === "snooze") {
    const days = threshold(db, "desk.snoozeDays");
    const until = new Date(now.getTime() + days * 86_400_000).toISOString();
    db.update(proposals).set({ state: "snoozed", snoozedUntil: until, decidedAt: at }).where(eq(proposals.id, id)).run();
    return { proposal: { ...proposal, state: "snoozed", snoozedUntil: until, decidedAt: at }, label: `Back in ${days} days` };
  }

  if (decision === "dismiss") {
    db.update(proposals).set({ state: "dismissed", decidedAt: at }).where(eq(proposals.id, id)).run();
    return { proposal: { ...proposal, state: "dismissed", decidedAt: at }, label: "Won't ask again" };
  }

  const { label, href, undo } = commit(db, proposal, now);
  try {
    db.update(proposals).set({ state: "accepted", decidedAt: at }).where(eq(proposals.id, id)).run();
  } catch (err) {
    undo();
    throw err;
  }
  undos.set(id, undo);
  return { proposal: { ...proposal, state: "accepted", decidedAt: at }, label, href };
}

/**
 * The undo for each accepted proposal, held in memory for as long as the process lives.
 *
 * In memory on purpose. An undo is a reversal offered for eight seconds to somebody who is
 * looking at the line that offers it; it is not a durable promise, and a restart losing it costs
 * nothing anybody was relying on. Writing closures to disk, or re-deriving a reversal from a
 * payload hours later, would both be pretending otherwise -- and the second one would reverse
 * whatever the world looks like then rather than what this press actually did.
 */
const undos = new Map<number, () => void>();

/** Reverse an accepted proposal and put it back on the desk. Silent when there is nothing to
 * reverse: the offer has expired, the server restarted, or it was already undone. */
export function undoProposal(db: DB, id: number): { proposal: Proposal } | null {
  const proposal = db.select().from(proposals).where(eq(proposals.id, id)).get();
  if (!proposal || proposal.state !== "accepted") return null;
  const undo = undos.get(id);
  if (!undo) return null;
  undo();
  undos.delete(id);
  db.update(proposals).set({ state: "open", decidedAt: null }).where(eq(proposals.id, id)).run();
  return { proposal: { ...proposal, state: "open", decidedAt: null } };
}

/** Test seam: the undo map is process-global, like the job worker's own singletons. */
export function resetUndos(): void {
  undos.clear();
}
