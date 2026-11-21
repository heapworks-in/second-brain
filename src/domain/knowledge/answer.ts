import { z } from "zod";
import type { DB } from "@/db/client";
import type { EmbedProvider } from "@/providers/embed/types";
import type { ChatProvider } from "@/providers/chat";
import { search, type SearchResult } from "@/domain/search";
import { getItemChunks } from "@/domain/items";
import { sourceWeight } from "./feedback";

/** How many items are retrieved before weighting, and how many survive into the prompt. */
const RETRIEVE = 12;
const KEEP = 6;

/** Characters of each source put in front of the model. Roughly a chunk and its neighbours. */
const PER_SOURCE = 1200;

export interface Source {
  itemId: number;
  chunkId: number;
  title: string;
  type: string;
  excerpt: string;
  score: number;
}

export interface Answer {
  /** Prose, or the empty string when the corpus had nothing to say. */
  text: string;
  /** What it was built from, in the order the model was shown them. */
  sources: Source[];
  /** Why there is no answer, when there is none: no model, nothing retrieved, nothing grounded. */
  unavailable?: string;
}

const Grounded = z.object({
  /** Empty when the sources do not answer it. Enforced in the prompt and checked below. */
  answer: z.string(),
  /** 1-based positions of the sources actually used, so an unused source is not credited. */
  used: z.array(z.number().int().min(1)).default([]),
});

const SYSTEM = [
  "You answer questions using only the numbered sources given to you. The sources are the user's",
  "own notes, documents and meeting records.",
  "Rules you must not break:",
  "1. Use only what the sources say. Never add facts from your own knowledge, however certain.",
  "2. If the sources do not answer the question, return an empty answer. Saying nothing is correct",
  "   and useful; a plausible answer that is not in the sources is worse than no answer.",
  "3. Cite as you go, with the source's number in square brackets: 'we froze the schema [2]'.",
  "4. List in `used` the numbers of the sources you actually drew on, and no others.",
  "5. Be brief. Two or three sentences unless the question genuinely needs more.",
  "6. Where sources disagree, say so and cite both rather than picking one.",
].join("\n");

/**
 * The corpus's own words around a hit, not just the matched chunk.
 *
 * A chunk is a 375-word window chosen to be a good retrieval unit, which is not the same as a
 * good reading unit: the sentence that answers the question is often in the chunk the hit's
 * neighbour. Pulling the neighbours back costs nothing -- they are rows in the same table -- and
 * it is the cheapest accuracy there is here.
 */
function excerptFor(db: DB, hit: SearchResult): string {
  const all = getItemChunks(db, hit.item.id);
  const at = all.findIndex((c) => c.id === hit.chunkId);
  const window = at < 0 ? all.slice(0, 2) : all.slice(Math.max(0, at - 1), at + 2);
  return window
    .map((c) => c.text)
    .join(" ")
    .slice(0, PER_SOURCE);
}

/**
 * Answer a question out of the knowledge base, or say that it cannot be answered from it.
 *
 * Grounding is the whole design, and the refusal path is the feature rather than the fallback.
 * A personal knowledge base is small -- a few dozen documents, not the internet -- so most
 * questions genuinely are not in it, and a system that answers them anyway from the model's own
 * training is worse than useless: it is confidently wrong about your own work, in your own words,
 * with a citation-shaped sentence next to it. "Nothing here covers that" is a true answer and the
 * one that tells you to go and write the document.
 *
 * Retrieval is the existing hybrid search -- FTS5 and vectors, fused -- reweighted by what has
 * been useful before, then cut to `KEEP`. The reweighting is deliberately gentle: it reorders
 * what retrieval found, and never adds or removes a candidate.
 */
export async function answerFromKnowledge(
  db: DB,
  deps: { embed: EmbedProvider | null; chat: ChatProvider | null },
  question: string,
  now = new Date(),
): Promise<Answer> {
  const asked = question.trim();
  if (!asked) return { text: "", sources: [], unavailable: "Nothing was asked" };

  const hits = await search(db, deps.embed, asked, {}, RETRIEVE);
  if (hits.length === 0) {
    return { text: "", sources: [], unavailable: "Nothing in the knowledge base matched that" };
  }

  const ranked = hits
    .map((hit) => ({ hit, weight: sourceWeight(db, hit.item.id, now) }))
    .sort((a, b) => b.hit.score * b.weight - a.hit.score * a.weight)
    .slice(0, KEEP);

  const sources: Source[] = ranked.map(({ hit, weight }) => ({
    itemId: hit.item.id,
    chunkId: hit.chunkId,
    title: hit.item.title,
    type: hit.item.type,
    excerpt: excerptFor(db, hit),
    score: hit.score * weight,
  }));

  if (!deps.chat) {
    // The sources are worth handing back even with no model to read them: this is then the search
    // results, which is strictly more than nothing and the same shape the caller already handles.
    return { text: "", sources, unavailable: "No local summary model, so these are the sources only" };
  }

  const grounded = Grounded.parse(
    await deps.chat.structured({
      system: SYSTEM,
      user: [
        `Question: ${asked}`,
        "",
        "Sources:",
        ...sources.map((s, i) => `[${i + 1}] ${s.title} (${s.type})\n${s.excerpt}`),
      ].join("\n"),
      schema: Grounded,
      name: "answer_from_sources",
      description: "Answer the question from the numbered sources, or return an empty answer.",
    }),
  );

  const text = grounded.answer.trim();
  if (!text) return { text: "", sources, unavailable: "The sources do not answer that" };

  // Only what it said it used, and only numbers that exist. A model that cites [7] of six sources
  // must not be able to credit a source that was never shown to it -- the feedback loop reads
  // these, so a bogus citation would teach the ranker something that never happened.
  const used = [...new Set(grounded.used)].filter((n) => n >= 1 && n <= sources.length).map((n) => sources[n - 1]);
  return { text, sources: used.length > 0 ? used : sources };
}
