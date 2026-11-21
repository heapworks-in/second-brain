import { describe, it, expect, afterEach, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { askLog, proposalBriefs, proposals } from "@/db/schema";
import { captureNote } from "@/domain/items/capture";
import { reconcileProposals } from "@/domain/desk/reconcile";
import type { ProposalDraft } from "@/domain/desk/types";
import type { ChatProvider } from "@/providers/chat";
import { briefProposals, briefsFor } from "./brief";
import { unansweredQuestions } from "./feedback";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-21T12:00:00.000Z");
const chat = (answer: unknown): ChatProvider => ({ structured: vi.fn().mockResolvedValue(answer) });

function draftOf(over: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    kind: "ask_unanswered",
    source: "observation",
    sourceRef: `observation:${Math.random()}`,
    title: "can you confirm the schema freeze?",
    detail: "Priya asked in #project-atlas",
    payload: {},
    urgency: 0.5,
    ...over,
  } as ProposalDraft;
}

/**
 * One sweep's worth of cards.
 *
 * All of them in a single `reconcileProposals` call, because a sweep expires any open row it did
 * not emit -- so reconciling one draft at a time would leave only the last card standing, which
 * is correct of reconcile and was a bug in this helper.
 */
function cards(...overrides: Partial<ProposalDraft>[]): number[] {
  reconcileProposals(t.db, overrides.map(draftOf), NOW);
  const byRef = new Map(t.db.select({ id: proposals.id, ref: proposals.sourceRef }).from(proposals).all().map((r) => [r.ref, r.id]));
  return [...byRef.values()];
}

const card = (over: Partial<ProposalDraft> = {}): number => cards(over)[0];

function corpus() {
  t = makeTestDb();
  captureNote(t.db, { title: "Migration plan", body: "We froze schema changes until the audit finishes. Priya owns the rollback." });
}

describe("briefProposals", () => {
  /* The whole argument for a knowledge base over a search page: the thing you were already
   * looking at arrives with the context attached. */
  it("attaches what the corpus knows to a card on the desk", async () => {
    corpus();
    const id = card();
    const out = await briefProposals(t.db, { embed: null, chat: chat({ answer: "Frozen until the audit finishes [1].", used: [1] }) }, NOW);
    expect(out.briefed).toBe(1);
    const brief = briefsFor(t.db, [id]).get(id)!;
    expect(brief.title).toBe("Migration plan");
    expect(brief.excerpt).toContain("audit finishes");
  });

  /* A brief is a model round trip and the sweep runs every fifteen minutes. Recomputing an answer
   * that has not changed, ninety-six times a day, for every card on the board, is the difference
   * between this being free and this being the reason the fans come on. */
  it("does not look a card up twice", async () => {
    corpus();
    card();
    const provider = chat({ answer: "Frozen [1].", used: [1] });
    await briefProposals(t.db, { embed: null, chat: provider }, NOW);
    const out = await briefProposals(t.db, { embed: null, chat: provider }, NOW);
    expect(out).toEqual({ briefed: 0, empty: 0 });
  });

  it("remembers that a card had nothing, so it is not retried forever", async () => {
    corpus();
    const id = card({ title: "zzzqqq unrelated terminology" });
    expect(await briefProposals(t.db, { embed: null, chat: chat({ answer: "", used: [] }) }, NOW)).toEqual({ briefed: 0, empty: 1 });
    // Recorded as looked-at, but there is no brief to render.
    expect(t.db.select().from(proposalBriefs).all()).toHaveLength(1);
    expect(briefsFor(t.db, [id]).size).toBe(0);
    expect((await briefProposals(t.db, { embed: null, chat: chat({ answer: "", used: [] }) }, NOW)).empty).toBe(0);
  });

  /* Not every card is improved by the corpus. A prompt to write a number down is not a question
   * retrieval can answer, and briefing it spends a round trip to render a line nobody reads. */
  it("leaves alone the kinds a lookup cannot help", async () => {
    corpus();
    card({ kind: "prediction_due", title: "Log this week's prediction" });
    expect(await briefProposals(t.db, { embed: null, chat: chat({ answer: "x", used: [1] }) }, NOW)).toEqual({ briefed: 0, empty: 0 });
  });

  it("holds one pass to a handful of cards", async () => {
    corpus();
    cards(...Array.from({ length: 9 }, (_, i) => ({ sourceRef: `observation:${i}`, title: `schema question number ${i}` })));
    expect((await briefProposals(t.db, { embed: null, chat: chat({ answer: "Frozen [1].", used: [1] }) }, NOW)).briefed).toBe(5);
  });

  /* The brief path is the one that gets used, so it has to feed the ranker -- but a card title
   * the corpus knows nothing about is not a document the user was missing, and letting these into
   * that list would bury the real signal. */
  it("feeds the ranker without polluting the list of questions I asked", async () => {
    corpus();
    card({ title: "zzzqqq unrelated terminology" });
    await briefProposals(t.db, { embed: null, chat: chat({ answer: "", used: [] }) }, NOW);
    expect(t.db.select().from(askLog).all()).toHaveLength(1);
    expect(t.db.select().from(askLog).get()!.source).toBe("brief");
    expect(unansweredQuestions(t.db)).toEqual([]);
  });

  it("does nothing when there is no model to read the sources", async () => {
    corpus();
    const id = card();
    await briefProposals(t.db, { embed: null, chat: null }, NOW);
    // Sources without prose are still worth attaching: that is the search result.
    expect(briefsFor(t.db, [id]).get(id)?.title).toBe("Migration plan");
  });
});
