import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { observations } from "@/db/schema";
import { createTask } from "@/domain/tasks";
import { ingestBatch, ingestObservations, linkObservationToTask } from "@/domain/observations";
import { askUnanswered } from "./ask-unanswered";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-14T12:00:00.000Z");

function ask(over: Record<string, unknown> = {}) {
  ingestObservations(
    t.db,
    [
      {
        source: "slack",
        externalId: `x${Math.random()}`,
        at: "2026-11-01T09:00:00.000Z",
        kind: "mention",
        actorHandle: "priya",
        actorName: "Priya Raman",
        text: "can you confirm the Q4 numbers before Friday?",
        context: "#project-atlas",
        ...over,
      },
    ],
    NOW,
  );
}

describe("askUnanswered", () => {
  it("proposes an ask nobody has answered", () => {
    t = makeTestDb();
    ask();
    const [draft] = askUnanswered(t.db, NOW);
    expect(draft.kind).toBe("ask_unanswered");
    expect(draft.title).toBe("can you confirm the Q4 numbers before Friday?");
    expect(draft.detail).toContain("Priya Raman");
    expect(draft.detail).toContain("#project-atlas");
    expect(draft.detail).toContain("13 days ago");
  });

  it("says nothing about a message that already became a task", () => {
    t = makeTestDb();
    ask();
    const row = t.db.select().from(observations).all()[0];
    linkObservationToTask(t.db, row.id, createTask(t.db, { title: "Confirm Q4" }).id);
    expect(askUnanswered(t.db, NOW)).toEqual([]);
  });

  it("stays quiet about a conversation happening right now", () => {
    // Four hours, because a mention from twenty minutes ago is one you are probably mid-reply
    // to, and a card about it is the firehose the desk exists to avoid.
    t = makeTestDb();
    ask({ at: "2026-11-14T11:00:00.000Z" });
    expect(askUnanswered(t.db, NOW)).toEqual([]);
  });

  it("grows more urgent the longer somebody waits", () => {
    t = makeTestDb();
    ask({ at: "2026-11-13T09:00:00.000Z" });
    ask({ at: "2026-10-20T09:00:00.000Z" });
    const [older, newer] = askUnanswered(t.db, NOW).sort((a, b) => b.urgency - a.urgency);
    expect(older.urgency).toBeGreaterThan(newer.urgency);
    expect(older.urgency).toBe(1);
  });

  it("names where it was when the text has aged out", () => {
    // Past the TTL the text is gone, and the card must not pretend to quote what is no longer
    // held -- but the ask itself is still owed, so it keeps its place.
    t = makeTestDb();
    ask({ text: "" });
    const [draft] = askUnanswered(t.db, NOW);
    expect(draft.title).toBe("Priya Raman asked something in #project-atlas");
  });

  it("carries the message date in the payload, so accepting dates the wait correctly", () => {
    t = makeTestDb();
    ask();
    expect(askUnanswered(t.db, NOW)[0].payload.askedAt).toBe("2026-11-01T09:00:00.000Z");
  });
});

describe("askUnanswered and broadcasts", () => {
  it("does not ask you to answer an announcement", () => {
    t = makeTestDb();
    ask({ text: "@channel New Engineering Lead job in Toronto Canada" });
    expect(askUnanswered(t.db, NOW)).toHaveLength(0);
  });

  it("does not let announcements crowd out real asks", () => {
    // The cap is applied by the query, so excluding broadcasts has to happen in SQL. Filtered
    // afterwards instead, these twenty-five announcements would fill the cap of twenty and the
    // one genuine ask behind them would never reach the desk at all.
    t = makeTestDb();
    for (let i = 0; i < 25; i++) {
      ask({ at: `2026-10-${String(i + 1).padStart(2, "0")}T09:00:00.000Z`, text: `@channel posting ${i}` });
    }
    ask({ at: "2026-11-01T09:00:00.000Z", text: "can you confirm the Q4 numbers before Friday?" });

    const out = askUnanswered(t.db, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain("Q4 numbers");
  });
});

/**
 * The gap this feature had from the day it shipped: an ask stayed on the desk until it was
 * dismissed by hand, however long ago it had been dealt with in Slack. "Did I reply?" has no
 * answer at all without memory of the conversation, so it was never asked.
 */
describe("askUnanswered and a reply I already sent", () => {
  function mentionIn(channel: string, tail: { mineAt?: string; theirsAt?: string }) {
    ingestBatch(
      t.db,
      {
        conversations: [{ source: "slack", externalId: channel, name: "#project-atlas", ...tail }],
        observations: [
          {
            source: "slack",
            externalId: `${channel}/${Math.random()}`,
            at: "2026-11-01T09:00:00.000Z",
            kind: "mention",
            actorHandle: "priya",
            actorName: "Priya Raman",
            text: "can you confirm the Q4 numbers before Friday?",
            context: "#project-atlas",
          },
        ],
      },
      NOW,
    );
  }

  it("drops the card once I have spoken in that conversation since", () => {
    t = makeTestDb();
    mentionIn("C1", { mineAt: "2026-11-01T09:30:00.000Z" });
    expect(askUnanswered(t.db, NOW)).toEqual([]);
  });

  it("keeps it when my last word there came before they asked", () => {
    t = makeTestDb();
    mentionIn("C2", { mineAt: "2026-10-20T09:00:00.000Z" });
    expect(askUnanswered(t.db, NOW)).toHaveLength(1);
  });

  /* They asked twice and I still have not answered: somebody else speaking is not me replying,
   * and reading it as one would lose the ask entirely. */
  it("still owes a reply when only they have spoken since", () => {
    t = makeTestDb();
    mentionIn("C3", { theirsAt: "2026-11-09T09:00:00.000Z" });
    expect(askUnanswered(t.db, NOW)).toHaveLength(1);
  });

  it("keeps it when nothing is known about the conversation", () => {
    // Fail-open: an adaptor that cannot say where a message was said must not lose the ask.
    t = makeTestDb();
    ask();
    expect(askUnanswered(t.db, NOW)).toHaveLength(1);
  });
});

describe("askUnanswered and a model's verdict", () => {
  it("drops what a model read and said was not asking for anything", () => {
    t = makeTestDb();
    ask({ meta: { judge: { ask: false } } });
    expect(askUnanswered(t.db, NOW)).toEqual([]);
  });

  /* The verdict is allowed to improve a card. It is never allowed to be the reason one vanishes,
   * so every way of having no verdict -- no model, job not run yet, unparseable meta -- reads as
   * an ask. */
  it("keeps an unjudged ask, and one whose meta will not parse", () => {
    t = makeTestDb();
    ask();
    expect(askUnanswered(t.db, NOW)).toHaveLength(1);
  });

  it("titles the card with what the model said is wanted", () => {
    t = makeTestDb();
    ask({ meta: { judge: { ask: true, what: "confirm the Q4 numbers" } } });
    expect(askUnanswered(t.db, NOW)[0].title).toBe("confirm the Q4 numbers");
  });
});
