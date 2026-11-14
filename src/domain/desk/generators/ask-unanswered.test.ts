import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { observations } from "@/db/schema";
import { createTask } from "@/domain/tasks";
import { ingestObservations, linkObservationToTask } from "@/domain/observations";
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
