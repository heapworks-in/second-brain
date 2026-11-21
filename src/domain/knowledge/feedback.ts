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

/** Citations before the weighting is believed at all. Below this, one accident is the whole signal. */
const MIN_EVIDENCE = 3;

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
  if (shown < MIN_EVIDENCE) return 1;

  const cited = row?.cited ?? 0;
  const helped = row?.helped ?? 0;
  const hurt = row?.hurt ?? 0;

  // Centred on 1: a citation rate of a half leaves an item exactly where retrieval put it, and
  // the two halves of the range are deliberately lopsided -- being cited every time is good
  // evidence, being cited never is better evidence, because it means retrieval keeps choosing
  // something a reader then had no use for.
  const rate = cited / shown;
  const fromCitations = 1 + (rate - 0.5) * 0.4;

  // A rating is a much stronger signal than a citation and is allowed to move more, but only
  // where somebody actually gave one.
  const rated = helped + hurt;
  const fromRatings = rated === 0 ? 0 : ((helped - hurt) / rated) * 0.2;

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
