import type { DB } from "@/db/client";
import type { EmbedProvider } from "@/providers/embed/types";
import type { ChatProvider } from "@/providers/chat";
import { search } from "@/domain/search";
import { answerFromKnowledge } from "./answer";
import { sourceWeight } from "./feedback";

/**
 * One question and what should come back for it.
 *
 * Titles rather than ids, so a case can be written by hand before the documents exist and survives
 * re-importing the corpus.
 *
 * `forbid` is the other half, and the half that catches the failure nobody looks for: one
 * document that matches everything. A long meeting transcript full of common words will quietly
 * rank into the top three for every unrelated question, and recall alone goes *up* when that
 * happens. Naming what must not come back is how that gets caught.
 */
export interface EvalCase {
  question: string;
  expect: string[];
  forbid?: string[];
}

/**
 * A question whose answer is genuinely not in the corpus.
 *
 * Deliberately a different type from `EvalCase`, because it measures a different component.
 * Retrieval cannot refuse: asked about something absent it returns its best ten matches anyway,
 * because that is what ranking does. Whether the system *says* it does not know is decided by the
 * model reading those sources, so it can only be measured through the answer path.
 *
 * The first version of this file got that wrong. It scored refusal by thresholding the fused
 * retrieval score, which cannot work: reciprocal rank fusion scores a position, not a relevance,
 * and with k=60 the best attainable score is 1/61. Every threshold is either above all of them or
 * below all of them, so the measurement was a constant wearing a number's clothes.
 */
export interface RefusalCase {
  question: string;
}

export interface CaseResult {
  question: string;
  recall: number;
  /** 1 when the best-ranked result was expected. Blunt on purpose: an answer is built from the top
   * handful, so what matters is what is at the top, not what is somewhere in ten. */
  topHit: number;
  /** Forbidden titles that turned up in the top three anyway. */
  intruders: string[];
  got: string[];
}

export interface EvalReport {
  cases: CaseResult[];
  recall: number;
  precisionAtOne: number;
  /** Share of cases with no forbidden document in the top three. */
  cleanliness: number;
}

const TOP = 3;

/**
 * Measure retrieval against a fixed set of questions.
 *
 * Retrieval only, and deliberately: it is where the quality comes from, it is deterministic, and
 * it costs nothing to run on every change. Scoring generated prose needs a human or a bigger
 * model as judge, which turns an eval you run constantly into one you run twice and abandon.
 *
 * The weighting is applied, because the weighting is the thing that will change and "did the
 * feedback loop help or hurt?" is exactly the question nobody can answer by feel. Run it, change
 * something, run it again.
 */
export async function runEval(db: DB, embed: EmbedProvider | null, cases: EvalCase[], now = new Date()): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const hits = await search(db, embed, c.question, {}, 10);
    const got = hits
      .map((h) => ({ title: h.item.title, score: h.score * sourceWeight(db, h.item.id, now) }))
      .sort((a, b) => b.score - a.score)
      .map((h) => h.title);
    const found = c.expect.filter((title) => got.includes(title)).length;
    results.push({
      question: c.question,
      recall: c.expect.length === 0 ? 1 : found / c.expect.length,
      topHit: got.length > 0 && c.expect.includes(got[0]) ? 1 : 0,
      intruders: (c.forbid ?? []).filter((title) => got.slice(0, TOP).includes(title)),
      got,
    });
  }
  const mean = (xs: number[]) => (xs.length === 0 ? 1 : xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    cases: results,
    recall: mean(results.map((r) => r.recall)),
    precisionAtOne: mean(results.map((r) => r.topHit)),
    cleanliness: mean(results.map((r) => (r.intruders.length === 0 ? 1 : 0))),
  };
}

export interface RefusalReport {
  /** Share of absent questions the system correctly declined to answer. */
  refusalRate: number;
  /** The ones it answered anyway, with what it said -- the only output here worth reading, because
   * each one is a confident falsehood about the user's own work. */
  invented: { question: string; answered: string }[];
}

/**
 * Measure whether the system says "I don't know" when it should.
 *
 * The most important number in this file and the one that needs a real model to produce, so it is
 * separate and slower: every case is a round trip. Worth it, because the failure it measures is
 * the one that makes a knowledge base worse than no knowledge base -- a confident answer about
 * your own work, drawn from the model's training rather than your documents, with a citation next
 * to it. Recall can be improved by answering more; only this stops that being an improvement.
 */
export async function runRefusalEval(
  db: DB,
  deps: { embed: EmbedProvider | null; chat: ChatProvider | null },
  cases: RefusalCase[],
  now = new Date(),
): Promise<RefusalReport> {
  const invented: { question: string; answered: string }[] = [];
  for (const c of cases) {
    const out = await answerFromKnowledge(db, deps, c.question, now);
    if (out.text.trim() !== "") invented.push({ question: c.question, answered: out.text });
  }
  return { refusalRate: cases.length === 0 ? 1 : (cases.length - invented.length) / cases.length, invented };
}
