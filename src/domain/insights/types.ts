import type { DB } from "@/db/client";

/**
 * Something true about your data or this app that you would otherwise have to go and find out.
 *
 * The distinction from a desk proposal is the whole point and is worth stating plainly: **a
 * proposal asks you to decide something; an insight asks nothing at all.** If there is an action
 * and the app knows what it is, it belongs on the desk, where accepting commits it and dismissing
 * teaches the ranker. If the honest answer is "you should know this", it belongs here.
 *
 * The set shipped first is not a guess at what might be interesting. Every one of them is a thing
 * that had to be dug out of the database by hand on 2026-11-15, after which several turned out to
 * explain why whole features had never produced anything: the calendar held nothing but holidays,
 * so meeting prep could never fire; Accessibility was never granted, so window titles and Slack
 * were never captured; the desk had never been answered in its entire existence. The machinery was
 * running in every case. Nothing said the inputs were missing.
 */
export interface Insight {
  /** Stable across reads, so a list can be keyed and a finding referred to. */
  id: string;
  /**
   * `blocked` means a capability cannot work at all until something changes -- the strongest
   * claim here and the one worth being right about. `notable` is a pattern worth seeing.
   * `good` exists so the page is not only ever bad news, which is how a page stops being read.
   */
  severity: "blocked" | "notable" | "good";
  /** The fact, as a sentence. Numbers in it, not adjectives. */
  headline: string;
  /** Why it matters, and what it means in practice. */
  detail: string;
  /** Where to go about it, when there is somewhere. */
  href?: string;
  /** What that link does, named for the outcome. */
  action?: string;
}

/**
 * Pure and synchronous, like the desk's generators and for the same reason: the embedding provider
 * can be switched off entirely, and a page that empties when a model is missing would be worse
 * than no page. `now` is the only clock.
 *
 * Unlike proposals, insights are computed on read and never stored. They need no identity across
 * sweeps, no dismissal and no undo -- they are derived facts, and a table would be a cache of
 * something cheap to recompute.
 */
export type InsightGenerator = (db: DB, now: Date) => Insight[];
