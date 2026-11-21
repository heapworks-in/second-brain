import { describe, it, expect, afterEach, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { askLog, askSources } from "@/db/schema";
import { captureNote } from "@/domain/items/capture";
import type { ChatProvider } from "@/providers/chat";
import { answerFromKnowledge } from "./answer";
import { ask } from "./ask";
import { rateAsk, recordAsk, sourceWeight, unansweredQuestions } from "./feedback";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-21T12:00:00.000Z");

/** No embedding provider in tests: FTS alone retrieves, which is the honest floor anyway. */
const noEmbed = null;

function chat(answer: unknown): ChatProvider {
  return { structured: vi.fn().mockResolvedValue(answer) };
}

function corpus() {
  t = makeTestDb();
  captureNote(t.db, { title: "Migration plan", body: "We froze schema changes until the audit finishes. Priya owns the rollback." });
  captureNote(t.db, { title: "Hiring loop", body: "The onsite is four interviews and a debrief the same afternoon." });
}

describe("answerFromKnowledge", () => {
  it("answers from the corpus and credits only what the model used", async () => {
    corpus();
    const out = await answerFromKnowledge(
      t.db,
      { embed: noEmbed, chat: chat({ answer: "Schema changes are frozen until the audit finishes [1].", used: [1] }) },
      "what is the state of schema changes?",
      NOW,
    );
    expect(out.text).toContain("frozen until the audit");
    expect(out.cited).toHaveLength(1);
    expect(out.cited[0].title).toBe("Migration plan");
  });

  /* The refusal path is the feature, not the fallback. A personal corpus is a few dozen documents,
   * so most questions genuinely are not in it -- and a confident answer drawn from the model's own
   * training, wearing a citation, is worse than useless: it is wrong about your own work. */
  it("says the corpus does not cover it rather than answering anyway", async () => {
    corpus();
    const out = await answerFromKnowledge(
      t.db,
      { embed: noEmbed, chat: chat({ answer: "   ", used: [] }) },
      "what is the state of schema changes?",
      NOW,
    );
    expect(out.text).toBe("");
    expect(out.unavailable).toBe("The sources do not answer that");
    // The sources still come back -- that is the search result, and strictly more than nothing --
    // but nothing is credited, which is the distinction the ranker depends on.
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.cited).toEqual([]);
  });

  it("says so when nothing matched at all, without calling the model", async () => {
    corpus();
    const provider = chat({ answer: "anything", used: [1] });
    const out = await answerFromKnowledge(t.db, { embed: noEmbed, chat: provider }, "zzzqqq nonexistent terminology", NOW);
    expect(out.unavailable).toBe("Nothing in the knowledge base matched that");
    expect(provider.structured).not.toHaveBeenCalled();
  });

  it("hands back sources alone when the machine has no summary model", async () => {
    corpus();
    const out = await answerFromKnowledge(t.db, { embed: noEmbed, chat: null }, "schema changes", NOW);
    expect(out.text).toBe("");
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.unavailable).toContain("No local summary model");
  });

  /* A model that cites [7] of six sources must not be able to credit something it was never
   * shown. The feedback loop reads these citations, so a bogus one would teach the ranker about
   * an event that did not happen. */
  it("ignores a citation that points at nothing", async () => {
    corpus();
    const out = await answerFromKnowledge(
      t.db,
      { embed: noEmbed, chat: chat({ answer: "Something [7].", used: [7, 99] }) },
      "schema changes",
      NOW,
    );
    expect(out.cited).toEqual([]);
    expect(out.text).toBe("Something [7].");
  });
});

describe("ask", () => {
  it("records the question, the candidates, and which were used", async () => {
    corpus();
    const out = await ask(
      t.db,
      { embed: noEmbed, chat: chat({ answer: "Frozen until the audit [1].", used: [1] }) },
      "schema changes",
      NOW,
    );
    const entry = t.db.select().from(askLog).get()!;
    expect(entry.question).toBe("schema changes");
    expect(out.askId).toBe(entry.id);
    const sources = t.db.select().from(askSources).all();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((s) => s.cited === 1)).toHaveLength(1);
  });

  /* The bug the live data showed, and the one this whole file is supposed to prevent. A refusal
   * shows six irrelevant documents and uses none of them; crediting what was merely shown taught
   * the ranker that whatever retrieval already favours is good. Every earlier test asserted on
   * `sources`, which was populated either way, so none of them caught it. */
  it("credits nothing at all when it refused to answer", async () => {
    corpus();
    await ask(t.db, { embed: noEmbed, chat: chat({ answer: "", used: [] }) }, "schema changes", NOW);
    const sources = t.db.select().from(askSources).all();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((s) => s.cited === 1)).toEqual([]);
  });

  /* The most useful thing in the log: a run of questions the corpus could not answer is a
   * self-generated list of the documents that are missing. */
  it("keeps the questions it could not answer", async () => {
    corpus();
    await ask(t.db, { embed: noEmbed, chat: chat({ answer: "", used: [] }) }, "what did we decide about pricing?", NOW);
    expect(unansweredQuestions(t.db).map((q) => q.question)).toEqual(["what did we decide about pricing?"]);
  });
});

describe("sourceWeight", () => {
  function shownTimes(itemId: number, times: number, opts: { cited: boolean; useful?: boolean }) {
    for (let i = 0; i < times; i++) {
      const { askId } = recordAsk(
        t.db,
        `q${i}`,
        {
          text: "an answer",
          sources: [{ itemId, chunkId: 1, title: "", type: "note", excerpt: "", score: 1 }],
          cited: opts.cited ? [{ itemId, chunkId: 1, title: "", type: "note", excerpt: "", score: 1 }] : [],
        },
        [{ itemId, chunkId: 1 }],
        NOW,
      );
      if (opts.useful !== undefined) rateAsk(t.db, askId, opts.useful);
    }
  }

  /* Exactly 1 until there is evidence. No cold-start guess: a guessed default is what makes a
   * feedback loop impossible to debug, because you cannot tell learned behaviour from invention. */
  it("is neutral until there is enough evidence to say anything", () => {
    corpus();
    shownTimes(1, 2, { cited: true });
    expect(sourceWeight(t.db, 1, NOW)).toBe(1);
  });

  it("lifts an item that keeps earning its place", () => {
    corpus();
    shownTimes(1, 6, { cited: true });
    expect(sourceWeight(t.db, 1, NOW)).toBeGreaterThan(1);
  });

  /* The most valuable thing here: something retrieval keeps choosing that a reader then has no
   * use for. Nudging it down is how the corpus stops being dominated by whatever matches best. */
  it("pushes down an item retrieval keeps picking and nobody uses", () => {
    corpus();
    shownTimes(1, 6, { cited: false });
    expect(sourceWeight(t.db, 1, NOW)).toBeLessThan(1);
  });

  it("stays inside a narrow band however one-sided the evidence", () => {
    corpus();
    shownTimes(1, 200, { cited: true, useful: true });
    const weight = sourceWeight(t.db, 1, NOW);
    expect(weight).toBeLessThanOrEqual(1.3);
    expect(weight).toBeGreaterThanOrEqual(0.8);
  });

  /* Almost nothing ever gets rated. Counting silence as disapproval would drive every weight to
   * the floor and call it learning. */
  it("does not read an unrated answer as a bad one", () => {
    corpus();
    shownTimes(1, 6, { cited: true });
    const unrated = sourceWeight(t.db, 1, NOW);
    shownTimes(2, 6, { cited: true, useful: true });
    expect(sourceWeight(t.db, 2, NOW)).toBeGreaterThan(unrated);
  });

  it("forgets evidence older than the window", () => {
    corpus();
    shownTimes(1, 6, { cited: false });
    expect(sourceWeight(t.db, 1, new Date("2027-06-01T00:00:00.000Z"))).toBe(1);
  });
});
