import type { DB } from "@/db/client";
import type { Generator, ProposalDraft } from "../types";
import { captureUnfiled } from "./capture-unfiled";
import { commitmentOwed } from "./commitment-owed";
import { commitmentUnbooked } from "./commitment-unbooked";
import { decisionStale } from "./decision-stale";
import { meetingUnprepared } from "./meeting-unprepared";
import { predictionDue } from "./prediction-due";
import { taskOverrun } from "./task-overrun";
import { taskStalled } from "./task-stalled";

/**
 * Every source the desk has. Adding one is adding a file and a line here — which is the whole
 * reason the queue exists as a table rather than as a page per kind: notifications, window text
 * and Slack all arrive as entries in this array, not as surfaces of their own.
 */
export const GENERATORS: { name: string; run: Generator }[] = [
  { name: "meeting_unprepared", run: meetingUnprepared },
  { name: "commitment_unbooked", run: commitmentUnbooked },
  { name: "commitment_owed", run: commitmentOwed },
  { name: "prediction_due", run: predictionDue },
  { name: "task_overrun", run: taskOverrun },
  { name: "task_stalled", run: taskStalled },
  { name: "capture_unfiled", run: captureUnfiled },
  { name: "decision_stale", run: decisionStale },
];

/**
 * Run the lot. One generator throwing must not cost the sweep the other six: a card missing for
 * a quarter of an hour is a nuisance, a desk that goes blank because one query met data it did
 * not expect is the kind of failure that gets a feature switched off for good.
 */
export function collectDrafts(db: DB, now: Date, log: (m: string) => void = () => {}): ProposalDraft[] {
  const drafts: ProposalDraft[] = [];
  for (const { name, run } of GENERATORS) {
    try {
      drafts.push(...run(db, now));
    } catch (err) {
      log(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return drafts;
}
