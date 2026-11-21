import { eq, inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import type { EmbedProvider } from "@/providers/embed/types";
import type { ChatProvider } from "@/providers/chat";
import { proposalBriefs, proposals, type ProposalBrief } from "@/db/schema";
import type { ProposalKind } from "@/db/enums";
import { nowIso } from "@/lib/time";
import { answerFromKnowledge } from "./answer";
import { recordAsk } from "./feedback";

/**
 * Kinds that are worth looking something up for.
 *
 * Not every card is. `prediction_due` is a prompt to write a number down and `capture_unfiled` is
 * a prompt to put something in a folder -- neither is improved by the corpus, and a brief on them
 * is a round trip spent to render a line nobody reads. The ones listed are the cards whose title
 * is a sentence about work, which is the only kind of thing retrieval can match on.
 */
const WORTH_BRIEFING: ProposalKind[] = [
  "ask_unanswered",
  "reply_awaited",
  "task_overdue",
  "task_stalled",
  "task_overrun",
  "meeting_unprepared",
  "decision_stale",
  "commitment_owed",
];

/** Cards briefed per pass. A sweep runs every quarter hour and each brief is a model round trip. */
const PER_PASS = 5;

/** Short enough to read on a card without opening anything. */
const EXCERPT = 240;

export interface BriefResult {
  briefed: number;
  /** Cards where the corpus had nothing relevant -- the common case, and not a failure. */
  empty: number;
}

/**
 * Attach what the knowledge base already knows to the cards waiting on the desk.
 *
 * This is the whole point of having a knowledge base rather than a search page. The desk already
 * decides what deserves attention; this makes each of those things arrive with the context you
 * would otherwise go and find -- the note where you decided this, the meeting where it was agreed,
 * the document that answers the question somebody is waiting on.
 *
 * Only unbriefed open cards, and only once each: a brief is cached in its own table precisely so
 * that fifteen minutes later nothing is recomputed. Cards whose corpus turns up nothing are
 * recorded as briefed with no row, so they are not retried every sweep forever -- which means a
 * document added later will not retroactively brief an old card, and that is the right trade. A
 * card is read in the days after it opens, not in the month after.
 */
export async function briefProposals(
  db: DB,
  deps: { embed: EmbedProvider | null; chat: ChatProvider | null },
  now = new Date(),
): Promise<BriefResult> {
  // One row per card already looked at, whether or not it found anything.
  const looked = new Set(db.select({ id: proposalBriefs.proposalId }).from(proposalBriefs).all().map((r) => r.id));
  const open = db
    .select({ id: proposals.id, kind: proposals.kind, title: proposals.title })
    .from(proposals)
    .where(eq(proposals.state, "open"))
    .all()
    .filter((p) => WORTH_BRIEFING.includes(p.kind as ProposalKind) && !looked.has(p.id))
    .slice(0, PER_PASS);

  const result: BriefResult = { briefed: 0, empty: 0 };
  for (const card of open) {
    const answer = await answerFromKnowledge(db, deps, card.title, now);
    // Recorded under "brief" so the ranker learns from the path that actually gets used, without
    // these turning up in the list of questions a person asked and the corpus could not answer.
    recordAsk(db, card.title, answer, answer.sources.map((s) => ({ itemId: s.itemId, chunkId: s.chunkId })), now, "brief");
    // What the model used, or -- with no model to read them -- the best thing retrieval found.
    // Never a source the model was shown and declined to use: that is the one case where a brief
    // would attach something confidently irrelevant to a card.
    const best = answer.cited[0] ?? (deps.chat ? undefined : answer.sources[0]);
    db.insert(proposalBriefs)
      .values({
        proposalId: card.id,
        itemId: best?.itemId ?? null,
        title: best?.title ?? null,
        // The model's own sentence when there is one -- it read the sources and said what matters
        // -- and the raw excerpt otherwise. Either beats the first 240 characters of a document.
        excerpt: best ? (answer.text || best.excerpt).replace(/\s+/g, " ").trim().slice(0, EXCERPT) : null,
        createdAt: nowIso(),
      })
      .onConflictDoNothing()
      .run();
    if (best) result.briefed += 1;
    else result.empty += 1;
  }
  return result;
}

/** The briefs for a page of cards, in one query -- rendering the desk must not be N lookups. */
export function briefsFor(db: DB, ids: number[]): Map<number, ProposalBrief> {
  if (ids.length === 0) return new Map();
  return new Map(
    db
      .select()
      .from(proposalBriefs)
      .where(inArray(proposalBriefs.proposalId, ids))
      .all()
      // Rows recording "looked, found nothing" are not briefs and have nothing to render.
      .filter((b) => b.itemId !== null && b.excerpt !== null)
      .map((b) => [b.proposalId, b]),
  );
}
