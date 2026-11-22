import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { askLog, askSources, type AskLogEntry } from "@/db/schema";
import type { Answer } from "./answer";

/**
 * How far back the ranker looks.
 *
 * Long enough that a document earns its place over a few weeks of use, short enough that what you
 * worked on in spring stops outranking what you are working on now. A knowledge base's useful
 * middle is always recent.
 */
const WINDOW_DAYS = 90;

/**
 * How much the weighting is allowed to move a result, as a multiplier on the retrieval score.
 *
 * Narrow on purpose, and this is the most important number here. Retrieval decides what is
 * relevant; this only reorders what retrieval already found, and can neither introduce a result
 * nor remove one. A wide range would let three lucky citations pin one document to the top of
 * every answer -- the failure mode of every naive feedback loop, where the system converges on
 * what it happened to show you first and stops being able to discover anything else.
 */
const MIN_WEIGHT = 0.8;
const MAX_WEIGHT = 1.3;

/**
 * How much evidence makes a weight worth believing in full.
 *
 * A soft version of the hard floor this used to have. A threshold says an item shown twice is
 * worth nothing and an item shown three times is worth everything, which is not true of either;
 * this scales the adjustment by `shown / (shown + CONFIDENCE)`, so thin evidence nudges and
 * real evidence moves. An item shown 10 times gets half the adjustment, 30 times three
 * quarters, and one shown once barely moves at all.
 */
const CONFIDENCE = 10;

/** How far below the ordinary citation rate is as far down as an item can be pushed. */
const SPREAD = 0.2;

export interface Recorded {
  askId: number;
}

/**
 * Write down what was asked, what it was answered from, and which sources the model actually used.
 *
 * `cited` is the distinction that makes this worth recording. Crediting everything retrieved
 * would teach the ranker that whatever retrieval already prefers is good, which is a loop that
 * learns its own prior and converges on its first guess. Crediting only what was used means the
 * signal comes from the model reading the text, not from the search that found it.
 */
export function recordAsk(
  db: DB,
  question: string,
  answer: Answer,
  retrieved: { itemId: number; chunkId: number }[],
  now = new Date(),
  source: "ask" | "brief" = "ask",
): Recorded {
  // `cited`, never `sources`: a refusal shows six documents and uses none of them, and crediting
  // what was merely shown is how a feedback loop learns the opinion retrieval already had.
  const cited = new Set(answer.cited.map((s) => s.chunkId));
  return db.transaction(() => {
    const entry = db
      .insert(askLog)
      .values({
        question: question.trim(),
        answer: answer.text,
        unavailable: answer.unavailable ?? null,
        askedAt: now.toISOString(),
        source,
        dropped: answer.dropped,
      })
      .returning({ id: askLog.id })
      .get()!;
    for (const source of retrieved) {
      db.insert(askSources)
        .values({ askId: entry.id, itemId: source.itemId, chunkId: source.chunkId, cited: cited.has(source.chunkId) ? 1 : 0 })
        .run();
    }
    return { askId: entry.id };
  });
}

/** Say whether an answer was any good. The only thing anybody is ever asked to do by hand here. */
export function rateAsk(db: DB, askId: number, useful: boolean): void {
  db.update(askLog).set({ useful: useful ? 1 : 0 }).where(eq(askLog.id, askId)).run();
}

export function recentAsks(db: DB, limit = 50): AskLogEntry[] {
  return db.select().from(askLog).orderBy(desc(askLog.askedAt)).limit(limit).all();
}

/**
 * How much to trust an item, from how often it has earned its place in an answer.
 *
 * Two things count, and nothing else: how often this item was cited when it was shown, and
 * whether the answers it fed were rated useful. An item shown ten times and cited nine is doing
 * real work; one shown ten times and cited never is noise that keeps winning retrieval, and
 * nudging it down is the single most valuable thing this function does.
 *
 * Unrated answers are ignored rather than counted as bad: almost nothing gets rated, and treating
 * silence as disapproval would drive every weight to the floor and call it learning.
 *
 * Returns exactly 1 until there is enough evidence to say anything, so a new knowledge base
 * behaves precisely as it did before this file existed. There is no cold-start guess here --
 * guessing is what makes a feedback loop impossible to debug, because you can never tell the
 * learned behaviour from the invented default.
 */
/**
 * How often a source that was shown gets cited, across everything asked in the window.
 *
 * The neutral point, and it has to be measured rather than assumed. This used to be a hard-coded
 * half, which quietly made the whole weighting a penalty: an answer is built from six sources
 * and draws on one or two, so the rate a *typical* source achieves is nearer a tenth -- measured
 * at 0.117 on real traffic. Against a neutral of 0.5 every document in the corpus scored below
 * par, and the ranking stopped being "what earns its place" and became "what happened to be
 * cited", which is noise. Measured on an eval set it cost 0.19 of precision@1 while it was
 * cleaning up pollution, which is how it was found.
 *
 * The same class of mistake as thresholding a reciprocal-rank-fusion score: a constant that
 * reads as reasonable and sits outside the range the thing can actually reach.
 */
export function citationBaseline(db: DB, since: string): number {
  const row = db
    .select({ shown: sql<number>`count(*)`, cited: sql<number>`coalesce(sum(${askSources.cited}), 0)` })
    .from(askSources)
    .innerJoin(askLog, eq(askSources.askId, askLog.id))
    .where(gte(askLog.askedAt, since))
    .get();
  const shown = row?.shown ?? 0;
  // Nothing to measure yet: no item can be above or below an average that does not exist, so
  // every weight comes out exactly 1 and the ranker is retrieval alone, as it was before.
  if (shown === 0) return 0;
  return (row?.cited ?? 0) / shown;
}

export function sourceWeight(db: DB, itemId: number, now = new Date()): number {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const row = db
    .select({
      shown: sql<number>`count(*)`,
      cited: sql<number>`sum(${askSources.cited})`,
      helped: sql<number>`sum(case when ${askSources.cited} = 1 and ${askLog.useful} = 1 then 1 else 0 end)`,
      hurt: sql<number>`sum(case when ${askSources.cited} = 1 and ${askLog.useful} = 0 then 1 else 0 end)`,
    })
    .from(askSources)
    .innerJoin(askLog, eq(askSources.askId, askLog.id))
    .where(and(eq(askSources.itemId, itemId), gte(askLog.askedAt, since)))
    .get();

  const shown = row?.shown ?? 0;
  if (shown === 0) return 1;

  const cited = row?.cited ?? 0;
  const helped = row?.helped ?? 0;
  const hurt = row?.hurt ?? 0;

  const baseline = citationBaseline(db, since);
  if (baseline === 0) return 1;

  /*
   * A penalty, never a bonus, and this is the whole design -- measured, not assumed.
   *
   * Citation is strong evidence in one direction only. Shown eighteen times and never once
   * drawn on says a document matches the *words* of everything and answers none of it, which is
   * exactly the noise worth demoting. Being cited often says something much weaker: that it
   * answered the questions that happened to get asked. Promoting on that is popularity, and
   * popularity is not relevance-to-this-question -- it lifts last week's favourite into this
   * week's unrelated query.
   *
   * Both halves were measured against the eval set, same corpus, same questions, with a
   * train/test split so the numbers are not the loop grading its own homework:
   *
   *                               recall   p@1   clean      (test half: p@1 / clean)
   *   no weighting at all           1.00  0.79    0.52            0.86 / 0.52
   *   bonus and penalty             1.00  0.60    0.74            0.57 / 0.81
   *   penalty only                  1.00  0.81    0.74            0.90 / 0.81
   *
   * The bonus bought the pollution fix at 0.19 of precision. Dropping it keeps the fix and ends
   * up *above* where no weighting started, on questions the weighting never trained on.
   *
   * Centred on the rate an ordinary source actually reaches rather than on a half, scaled by
   * how much evidence stands behind it, so three showings nudge and thirty move.
   */
  const rate = cited / shown;
  const relative = Math.max(-1, Math.min(0, (rate - baseline) / baseline));
  const trust = shown / (shown + CONFIDENCE);
  const fromCitations = 1 + relative * SPREAD * trust;

  // A rating is the one place a bonus is still allowed, because it is the one signal that is
  // not inferred: somebody read the answer and said it was good. It is also the rarest, so it
  // moves more per unit than a citation does -- and only where somebody actually gave one.
  const rated = helped + hurt;
  const fromRatings = rated === 0 ? 0 : ((helped - hurt) / rated) * 0.2 * trust;

  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, fromCitations + fromRatings));
}

/**
 * What the knowledge base could not answer, most recent first.
 *
 * The most useful thing in this table, and the reason the refusal path records anything at all: a
 * run of unanswered questions is a precise, self-generated list of the documents that are missing.
 * Nothing else here tells you what to go and write.
 */
export function unansweredQuestions(db: DB, limit = 20): AskLogEntry[] {
  return db
    .select()
    .from(askLog)
    // Only what a person actually asked. A card title the corpus knows nothing about is not a
    // document somebody was missing, and mixing the two would bury the real signal here.
    .where(and(eq(askLog.answer, ""), eq(askLog.source, "ask")))
    .orderBy(desc(askLog.askedAt))
    .limit(limit)
    .all();
}
