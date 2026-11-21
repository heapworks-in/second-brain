import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { observations } from "@/db/schema";
import { createTask } from "@/domain/tasks";
import { ingestBatch, ingestObservations, linkObservationToTask } from "@/domain/observations";
import { askUnanswered } from "./ask-unanswered";
import { replyAwaited } from "./reply-awaited";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-14T12:00:00.000Z");

function asked(over: Record<string, unknown> = {}) {
  ingestObservations(
    t.db,
    [
      {
        source: "slack",
        externalId: `x${Math.random()}`,
        at: "2026-11-01T09:00:00.000Z",
        kind: "sent",
        actorHandle: "avinash",
        actorName: "Avinash",
        text: "any update on the staging credentials?",
        context: "#project-atlas",
        ...over,
      },
    ],
    NOW,
  );
}

/** The same question, in a named conversation whose tail the reader could see. */
function askedIn(channel: string, tail: { mineAt?: string; theirsAt?: string }, over: Record<string, unknown> = {}) {
  ingestBatch(
    t.db,
    {
      conversations: [{ source: "slack", externalId: channel, name: "#project-atlas", ...tail }],
      observations: [
        {
          source: "slack",
          externalId: `${channel}/${Math.random()}`,
          at: "2026-11-01T09:00:00.000Z",
          kind: "sent",
          actorHandle: "avinash",
          actorName: "Avinash",
          text: "any update on the staging credentials?",
          context: "#project-atlas",
          ...over,
        },
      ],
    },
    NOW,
  );
}

describe("replyAwaited", () => {
  it("proposes a question of mine that nobody answered", () => {
    t = makeTestDb();
    asked();
    const [draft] = replyAwaited(t.db, NOW);
    expect(draft.kind).toBe("reply_awaited");
    expect(draft.title).toBe("any update on the staging credentials?");
    expect(draft.detail).toContain("#project-atlas");
    expect(draft.detail).toContain("13 days ago");
  });

  it("says nothing once somebody else has spoken since", () => {
    // Derived from the conversation, not reported per message: the reader says "the last thing
    // anyone else said here was at T" and the card stops being proposed. Nothing here goes
    // looking, and reconcile takes the card away.
    t = makeTestDb();
    askedIn("C1", { theirsAt: "2026-11-02T10:00:00.000Z" });
    expect(replyAwaited(t.db, NOW)).toEqual([]);
  });

  it("says nothing once I have spoken since -- I stopped waiting on it", () => {
    // A question followed by my own "thanks, all clear" is not one I am still waiting on, and
    // three questions in a row should leave only the last. Both fall out of `mineAt`.
    t = makeTestDb();
    askedIn("C2", { mineAt: "2026-11-03T08:00:00.000Z" });
    expect(replyAwaited(t.db, NOW)).toEqual([]);
  });

  it("still chases a question in a conversation nobody has spoken in since", () => {
    t = makeTestDb();
    askedIn("C3", { mineAt: "2026-11-01T09:00:00.000Z", theirsAt: "2026-10-28T09:00:00.000Z" });
    expect(replyAwaited(t.db, NOW)).toHaveLength(1);
  });

  it("does not let answered messages crowd out the ones still hanging", () => {
    // Same argument as broadcasts next door: the cap is applied by the query, so the answered
    // ones have to be excluded in SQL or twenty-five of them fill it.
    t = makeTestDb();
    for (let i = 0; i < 25; i++) {
      askedIn(`CA${i}`, { theirsAt: "2026-10-31T09:00:00.000Z" }, { at: `2026-10-${String(i + 1).padStart(2, "0")}T09:00:00.000Z` });
    }
    asked({ at: "2026-11-01T09:00:00.000Z", text: "any update on the staging credentials?" });

    const out = replyAwaited(t.db, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].title).toContain("staging credentials");
  });

  it("gives them a working day before it says anything", () => {
    // Six hours is not a person ignoring you, and a card about it is impatience rather than
    // something to act on.
    t = makeTestDb();
    asked({ at: "2026-11-14T06:00:00.000Z" });
    expect(replyAwaited(t.db, NOW)).toEqual([]);
  });

  it("grows more urgent the longer the silence lasts", () => {
    t = makeTestDb();
    asked({ at: "2026-11-13T09:00:00.000Z" });
    asked({ at: "2026-10-20T09:00:00.000Z" });
    const [older, newer] = replyAwaited(t.db, NOW).sort((a, b) => b.urgency - a.urgency);
    expect(older.urgency).toBeGreaterThan(newer.urgency);
  });

  it("names where it was said when the text has aged out", () => {
    t = makeTestDb();
    asked({ text: "" });
    expect(replyAwaited(t.db, NOW)[0].title).toBe("Something you asked in #project-atlas");
  });

  it("says nothing about a question already turned into a follow-up", () => {
    t = makeTestDb();
    asked();
    const row = t.db.select().from(observations).all()[0];
    linkObservationToTask(t.db, row.id, createTask(t.db, { title: "Follow up" }).id);
    expect(replyAwaited(t.db, NOW)).toEqual([]);
  });
});

describe("the two halves do not overlap", () => {
  it("never puts my own message on the board as something I owe a reply to", () => {
    // `askUnanswered` takes everything that is not a broadcast, so the day the adaptor started
    // reporting my own messages it would have started telling me to answer myself.
    t = makeTestDb();
    asked();
    expect(askUnanswered(t.db, NOW)).toEqual([]);
    expect(replyAwaited(t.db, NOW)).toHaveLength(1);
  });

  it("leaves somebody else's ask to the half that owns it", () => {
    t = makeTestDb();
    asked({ kind: "mention", actorName: "Priya Raman", text: "can you confirm the Q4 numbers?" });
    expect(replyAwaited(t.db, NOW)).toEqual([]);
    expect(askUnanswered(t.db, NOW)).toHaveLength(1);
  });
});
