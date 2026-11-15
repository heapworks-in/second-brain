import type { ProposalKind } from "@/db/enums";

/**
 * What the primary button says, per kind, in the words of its consequence.
 *
 * Never "Accept". A button labelled for the mechanism rather than the outcome makes the person
 * hold the mapping in their head, and that matters more on a board than it did on a single card:
 * a dozen buttons all reading "Accept" would be a dozen questions you cannot answer at a glance.
 * The server has the authoritative past tense (`decide.ts` returns it for the undo line); this is
 * the same sentence in the imperative.
 *
 * A function of the count, because the design is firm that a proposal must say exactly what
 * accepting will do, and a grouped row reading "Plan it for today" while planning seven things is
 * not that. Kinds that never group ignore the argument.
 */
export const PRIMARY_LABELS: Record<ProposalKind, (count: number) => string> = {
  meeting_unprepared: () => "Start a prep note",
  decision_stale: () => "Reaffirm",
  task_overrun: () => "Re-estimate",
  task_stalled: () => "Take it off the plan",
  task_overdue: (n) => (n === 1 ? "Plan it for today" : `Plan all ${n} for today`),
  prediction_due: () => "Resolve it",
  capture_unfiled: () => "File it",
  commitment_unbooked: () => "Book it",
  commitment_owed: () => "Plan it for today",
  ask_unanswered: () => "Owe it back",
};

/** Said once, under the evidence, when the kind has been refused enough to be worth admitting
 * to. Below a third it is noise; above it, it explains why the card is where it is in the list. */
export function dismissNote(rate: number): string | null {
  if (rate < 0.34) return null;
  return rate >= 0.99 ? "You have refused every one of these so far." : `You refuse about ${Math.round(rate * 100)}% of these.`;
}

/**
 * The headings on the board, and which kinds live under each.
 *
 * Grouped by the kind of attention a thing needs rather than by which generator made it. The
 * generators are an implementation detail; "someone is waiting on me" and "a date I set has gone
 * by" are the two different feelings you have about a list like this, and they want different
 * answers at different moments. Tabs were the obvious alternative and were rejected for the
 * reason the board exists at all: a tab is a thing you do not look at.
 *
 * Order is deliberate and fixed, worst consequence first. Within a section the ranker decides.
 */
export const SECTIONS = [
  {
    id: "waiting",
    title: "Someone is waiting on you",
    /** The only cost here that lands on a week that is not yours. */
    kinds: ["commitment_owed", "ask_unanswered"],
  },
  {
    id: "soon",
    title: "Happening soon",
    /** Time-boxed and unrepeatable: once the meeting starts the chance is gone. */
    kinds: ["meeting_unprepared"],
  },
  {
    id: "late",
    title: "Past its date",
    /** A date you set yourself and let go by. */
    kinds: ["task_overdue", "prediction_due", "decision_stale"],
  },
  {
    id: "wrong",
    title: "The plan disagrees with reality",
    kinds: ["task_stalled", "task_overrun"],
  },
  {
    id: "loose",
    title: "Loose ends",
    /** Something with no home, or no time set aside. */
    kinds: ["capture_unfiled", "commitment_unbooked"],
  },
] as const satisfies readonly { id: string; title: string; kinds: readonly ProposalKind[] }[];

/** Which section a kind belongs under. Built once from SECTIONS so the two cannot drift. */
const SECTION_OF = new Map<ProposalKind, string>(
  SECTIONS.flatMap((section) => section.kinds.map((kind) => [kind, section.id] as const)),
);

/** The sections that actually have something in them, in SECTIONS order, each ranked within. An
 *  empty heading is a heading you learn to skip. */
export function groupIntoSections<T extends { kind: ProposalKind }>(cards: T[]): { id: string; title: string; cards: T[] }[] {
  return SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    cards: cards.filter((card) => SECTION_OF.get(card.kind) === section.id),
  })).filter((section) => section.cards.length > 0);
}
