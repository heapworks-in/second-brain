import type { DB } from "@/db/client";
import { getSetting } from "@/domain/settings";

/**
 * Every number a generator uses to decide "too old", in one place and readable from `settings`,
 * for the same reason the kind weights are: a threshold that can only be changed by a rebuild is
 * one that gets argued with by dismissing the card instead, which teaches the ranker the wrong
 * lesson entirely -- that the kind is unwanted, when it was only impatient.
 */
const DEFAULTS = {
  /** Hours before a meeting that preparing is still useful. Shorter than a working day: a card
   * about tomorrow morning is not actionable this afternoon. */
  "desk.meetingPrepHours": 4,
  /** Days a standing call on a recurring meeting stands before it is worth re-asking. */
  "desk.decisionStaleDays": 90,
  /** Days a capture sits with no home before it is probably never getting one by itself. */
  "desk.captureUnfiledDays": 7,
  /** Distinct days on the plan with no focus minutes before planning it again is a fiction. */
  "desk.stalledPlanDays": 3,
  /** How far past its estimate a task runs before the estimate is the thing that is wrong. */
  "desk.overrunRatio": 1.5,
  /** Days a snooze lasts. "Not now" is one key; choosing a date is three. */
  "desk.snoozeDays": 7,
} as const;

export type ThresholdKey = keyof typeof DEFAULTS;

export function threshold(db: DB, key: ThresholdKey): number {
  const raw = Number(getSetting(db, key, ""));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULTS[key];
}
