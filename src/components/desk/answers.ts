import type { ProposalKind } from "@/db/enums";

/**
 * What the primary button says, per kind, in the words of its consequence.
 *
 * Never "Accept". A button labelled for the mechanism rather than the outcome makes the person
 * hold the mapping in their head, and the whole argument for one card at a time is that nothing
 * has to be held in the head. The server has the authoritative past tense (`decide.ts` returns
 * it for the undo line); this is the same sentence in the imperative.
 *
 * `detail` already carries the number this refers to, so these stay short enough to read without
 * moving your eyes off the card.
 */
export const PRIMARY_LABELS: Record<ProposalKind, string> = {
  meeting_unprepared: "Start a prep note",
  decision_stale: "Reaffirm",
  task_overrun: "Re-estimate",
  task_stalled: "Take it off the plan",
  prediction_due: "Resolve it",
  capture_unfiled: "File it",
  commitment_unbooked: "Book it",
  commitment_owed: "Plan it for today",
  ask_unanswered: "Owe it back",
};

/** Said once, under the evidence, when the kind has been refused enough to be worth admitting
 * to. Below a third it is noise; above it, it explains why the card is where it is in the list. */
export function dismissNote(rate: number): string | null {
  if (rate < 0.34) return null;
  return rate >= 0.99 ? "You have refused every one of these so far." : `You refuse about ${Math.round(rate * 100)}% of these.`;
}
