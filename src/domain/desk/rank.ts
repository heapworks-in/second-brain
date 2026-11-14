import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { proposals } from "@/db/schema";
import type { ProposalKind } from "@/db/enums";
import { getSetting } from "@/domain/settings";
import type { ProposalDraft } from "./types";

/** How many open proposals the desk will ever show. The cap is the feature: a queue that can
 * grow is a queue you stop looking at, and clearing seven is possible. */
export const OPEN_CAP = 7;

/** Decisions of one kind the dismiss rate is measured over. Short enough to follow a change of
 * mind within a fortnight's use, long enough that two impatient dismissals do not bury a kind. */
const DISMISS_WINDOW = 30;

/**
 * What a kind keeps even when it has been refused every single time.
 *
 * Without a floor, `1 - rate` reaches zero and the rank goes with it: urgency stops mattering,
 * two unrelated refused kinds tie at nothing, and the only way back up is a decision the desk
 * will now never offer. A tenth of the weight is enough to keep a refused kind sorted by its own
 * urgency at the bottom of the list, and to let one acceptance lift it straight back out.
 *
 * Muting a kind outright stays a deliberate act -- `desk.weight.<kind>`, a setting -- rather than
 * something nine impatient dismissals do by accident.
 */
const DISMISS_FLOOR = 0.1;

/**
 * What one kind is worth before any judgement is applied, as a setting so a whole class can be
 * muted or promoted without code. These are starting points, not findings: everything here gets
 * corrected by `dismissRate` as soon as there is anything to learn from.
 */
const DEFAULT_WEIGHTS: Record<ProposalKind, number> = {
  // Time-boxed and unrepeatable: once the meeting starts, the chance to prepare is gone.
  meeting_unprepared: 1,
  // Cheap to answer and the only thing standing between a recorded commitment and a lost one.
  commitment_unbooked: 0.9,
  // The only kind here whose cost is paid by somebody else's week, and the only one that gets
  // worse on its own while nothing happens.
  commitment_owed: 0.85,
  // Somebody is already waiting and does not know whether they were heard. Just under the owed
  // commitment it turns into, because that one has at least been written down.
  ask_unanswered: 0.8,
  prediction_due: 0.8,
  task_overrun: 0.7,
  task_stalled: 0.6,
  capture_unfiled: 0.5,
  // True for months either way; nothing breaks if it waits another day.
  decision_stale: 0.4,
};

export function weightOf(db: DB, kind: ProposalKind): number {
  const raw = Number(getSetting(db, `desk.weight.${kind}`, ""));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WEIGHTS[kind];
}

/**
 * How often this kind gets refused, over the last `DISMISS_WINDOW` decisions of that kind.
 *
 * This is the whole learning loop, and it is two counts. A kind refused nine times running sinks
 * far enough that it stops competing for the cap; one that is always accepted rises. Nothing is
 * ever silenced outright: `DISMISS_FLOOR` keeps a wholly refused kind rankable, because "never
 * useful so far" is not the same claim as "never show me this".
 *
 * `expired` and `snoozed` are not decisions and are not counted. Expiry means the condition
 * resolved itself, which is evidence the proposal was right, not that it was unwanted.
 */
export function dismissRate(db: DB, kind: ProposalKind): number {
  const recent = db
    .select({ state: proposals.state })
    .from(proposals)
    .where(and(eq(proposals.kind, kind), isNotNull(proposals.decidedAt), sql`${proposals.state} in ('accepted', 'dismissed')`))
    .orderBy(desc(proposals.decidedAt))
    .limit(DISMISS_WINDOW)
    .all();
  if (recent.length === 0) return 0;
  return recent.filter((r) => r.state === "dismissed").length / recent.length;
}

/**
 * `urgency * weight * (1 - (1 - DISMISS_FLOOR) * dismissRate)`, and deliberately nothing cleverer.
 *
 * A ranker you cannot explain to yourself is one you will not trust enough to act on, and at
 * seven cards there is nothing a model could find that these three numbers miss. It is also why
 * the dismiss rate is readable as a sentence on the card: "you have refused this nine times".
 */
export function rankDraft(db: DB, draft: ProposalDraft, rates?: Map<ProposalKind, number>): number {
  const urgency = Math.min(1, Math.max(0, draft.urgency));
  const rate = rates?.get(draft.kind) ?? dismissRate(db, draft.kind);
  return urgency * weightOf(db, draft.kind) * (1 - (1 - DISMISS_FLOOR) * rate);
}

/** One rate per kind present, so ranking a sweep's drafts is a handful of queries and not one
 * per draft. */
export function dismissRates(db: DB, kinds: Iterable<ProposalKind>): Map<ProposalKind, number> {
  const out = new Map<ProposalKind, number>();
  for (const kind of new Set(kinds)) out.set(kind, dismissRate(db, kind));
  return out;
}
