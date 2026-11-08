import { duePredictions } from "@/domain/predictions";
import { localDay } from "@/lib/time";
import type { Generator } from "../types";

const DAY_MS = 86_400_000;

/** What the card asks, in the shape the answer takes: a number, a yes/no, a right/wrong. */
const ASKS = {
  estimate: "What did it actually take?",
  risk: "Did it happen?",
  call: "Were you right?",
} as const;

/**
 * A call whose answer is knowable and which nobody has gone back to score.
 *
 * `duePredictions` already backs the line on Home, and the line has not been enough: a log
 * nobody resolves is a diary, and the calibration figures it produces are worse than no figures,
 * because they describe only the calls that happened to be fun to come back to. Being asked one
 * at a time, with the claim in front of you, is the difference.
 *
 * Accepting does not score it — the answer is a number or a yes, which only the person has — so
 * the commit opens the resolve step with this prediction already chosen.
 */
export const predictionDue: Generator = (db, now) => {
  return duePredictions(db, localDay(now.toISOString())).map((p) => {
    const overdue = Math.max(0, Math.floor((now.getTime() - Date.parse(`${p.resolveBy}T00:00:00`)) / DAY_MS));
    return {
      kind: "prediction_due" as const,
      source: "prediction" as const,
      sourceRef: `prediction:${p.id}`,
      title: p.claim,
      detail: overdue === 0 ? `Due today. ${ASKS[p.kind]}` : `Due ${overdue} ${overdue === 1 ? "day" : "days"} ago. ${ASKS[p.kind]}`,
      payload: { predictionId: p.id, kind: p.kind, claim: p.claim, resolveBy: p.resolveBy },
      // A fortnight overdue is as overdue as it needs to get; what matters is that it is asked.
      urgency: Math.min(1, overdue / 14 + 0.3),
    };
  });
};
