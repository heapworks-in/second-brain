import type { DB } from "@/db/client";
import type { EmbedProvider } from "@/providers/embed/types";
import type { ChatProvider } from "@/providers/chat";
import { search } from "@/domain/search";
import { answerFromKnowledge, type Answer } from "./answer";
import { recordAsk } from "./feedback";

export interface Asked extends Answer {
  /** What to send back to rate it. The only handle a caller needs to close the loop. */
  askId: number;
}

/**
 * Ask the knowledge base something, and record the asking.
 *
 * The recording is not optional and not a separate call a caller might forget: a loop that only
 * learns when somebody remembers to log is a loop that does not learn. What it writes down is
 * what was asked, what was retrieved, and which of those the model actually used -- and that
 * third thing is the only honest signal in here.
 */
export async function ask(
  db: DB,
  deps: { embed: EmbedProvider | null; chat: ChatProvider | null },
  question: string,
  now = new Date(),
): Promise<Asked> {
  const answer = await answerFromKnowledge(db, deps, question, now);
  // Re-read rather than threaded out of `answerFromKnowledge`: what was *retrieved* is the
  // denominator of the citation rate, and it has to be the full candidate set rather than the
  // handful that survived into the prompt. Cheap -- FTS and a vector lookup over a local corpus.
  const retrieved = (await search(db, deps.embed, question, {}, 12)).map((h) => ({ itemId: h.item.id, chunkId: h.chunkId }));
  const { askId } = recordAsk(db, question, answer, retrieved, now);
  return { ...answer, askId };
}
