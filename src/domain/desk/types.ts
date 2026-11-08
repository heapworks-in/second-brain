import type { ProposalKind } from "@/db/enums";
import type { DB } from "@/db/client";

/**
 * What a generator hands the sweep. Not a row: `rank` and `state` are the sweep's business, and
 * a generator that could set either would be able to put something at the top of the desk or
 * resurrect something already dismissed.
 */
export interface ProposalDraft {
  kind: ProposalKind;
  /** Which table the evidence came from, for the card's own attribution. */
  source: "meeting" | "decision" | "task" | "prediction" | "item";
  /** Identity across sweeps. Stable for as long as the thing being proposed is the same thing. */
  sourceRef: string;
  title: string;
  /** The evidence. One or two lines, no advice — the buttons carry that. */
  detail: string;
  /** Everything accepting commits, so no commit re-derives anything. */
  payload: Record<string, unknown>;
  /** Time pressure, 0..1, normalised by the generator because only it knows what pressure means
   * for its own kind: hours until a meeting, days past a resolve-by date, days since a capture. */
  urgency: number;
}

/**
 * Pure and synchronous, by contract. No provider, no network, no `new Date()` — `now` is the
 * only clock. The embedding provider can be switched off entirely (`SB_EMBED=off`), and a desk
 * that empties when a model is missing would be worse than no desk at all.
 */
export type Generator = (db: DB, now: Date) => ProposalDraft[];
