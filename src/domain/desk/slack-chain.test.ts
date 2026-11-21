import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { proposals } from "@/db/schema";
import { ingestBatch } from "@/domain/observations";
import { sweepDesk } from "./sweep";

let t: TestDb;
afterEach(() => t?.cleanup());

const MONDAY = new Date("2026-11-02T09:00:00.000Z");
const FRIDAY = new Date("2026-11-06T09:00:00.000Z");

const open = () =>
  t.db
    .select({ kind: proposals.kind, title: proposals.title, state: proposals.state })
    .from(proposals)
    .all()
    .filter((p) => p.state === "open");

/** One pass of the reader: what it kept, and what it could see of the conversation it was in. */
function pass(batch: Parameters<typeof ingestBatch>[1], now: Date) {
  ingestBatch(t.db, batch, now);
  sweepDesk(t.db, now);
}

/**
 * The whole chain, end to end, in the shape the reader actually drives it: ingest a pass, sweep,
 * read the desk.
 *
 * Worth owning as one test rather than trusting the units to compose, because the bug this fixes
 * was exactly a composition bug. Every piece was correct on its own -- the reader reported what it
 * saw, ingest stored it, the generator asked its question honestly -- and the question it could
 * ask with a single row in front of it was so much weaker than the real one that an ask you had
 * answered in Slack stayed on the desk until you dismissed it by hand.
 */
describe("a Slack ask, from the reader's pass to the desk and off it again", () => {
  it("raises a card, then takes it away once I have replied in that conversation", () => {
    t = makeTestDb();

    // Monday: Priya asks something in #project-atlas. Nobody has replied.
    pass(
      {
        conversations: [{ source: "slack", externalId: "C0A1B2C3D", name: "#project-atlas", theirsAt: "2026-11-02T08:55:00.000Z" }],
        observations: [
          {
            source: "slack",
            externalId: "C0A1B2C3D/1794000000.100100",
            at: "2026-11-02T08:55:00.000Z",
            kind: "mention",
            actorName: "Priya Raman",
            actorHandle: "priya",
            text: "can you confirm the Q4 numbers before Friday?",
            context: "#project-atlas",
          },
        ],
      },
      MONDAY,
    );
    // Four hours is the floor, so nothing yet -- a mention from this morning is a conversation.
    expect(open()).toEqual([]);

    const later = new Date("2026-11-02T14:00:00.000Z");
    sweepDesk(t.db, later);
    expect(open()).toMatchObject([{ kind: "ask_unanswered", title: "can you confirm the Q4 numbers before Friday?" }]);

    // Friday: I finally answer her, in Slack. The next pass is looking at that channel and can see
    // that the last thing said there was mine. Note it reports no messages at all -- my own reply
    // is not a question, so nothing about it is kept -- and the card still goes away.
    pass({ conversations: [{ source: "slack", externalId: "C0A1B2C3D", mineAt: "2026-11-06T08:30:00.000Z" }], observations: [] }, FRIDAY);
    expect(open()).toEqual([]);
  });

  it("chases a question of mine, and stops the moment somebody answers it", () => {
    t = makeTestDb();

    pass(
      {
        conversations: [{ source: "slack", externalId: "C9Z8Y7X6W", name: "#platform", mineAt: "2026-11-02T08:00:00.000Z" }],
        observations: [
          {
            source: "slack",
            externalId: "C9Z8Y7X6W/1794000001.100100",
            at: "2026-11-02T08:00:00.000Z",
            kind: "sent",
            actorName: "Avinash",
            text: "any update on the staging credentials?",
            context: "#platform",
          },
        ],
      },
      MONDAY,
    );
    // A working day before it says anything: the same afternoon would be impatience, not a task.
    expect(open()).toEqual([]);

    sweepDesk(t.db, new Date("2026-11-03T09:00:00.000Z"));
    expect(open()).toMatchObject([{ kind: "reply_awaited", title: "any update on the staging credentials?" }]);

    pass({ conversations: [{ source: "slack", externalId: "C9Z8Y7X6W", theirsAt: "2026-11-03T10:00:00.000Z" }], observations: [] }, new Date("2026-11-03T11:00:00.000Z"));
    expect(open()).toEqual([]);
  });

  /* The flap this design exists to prevent. Thirty seconds after the reply was seen, the user
   * scrolls up and the next pass reports a tail from before it -- or no tail at all. If that could
   * move the timestamp back, the card would return for something answered days ago, go away again
   * on the pass after, and keep doing it every half minute for as long as the app ran. */
  it("does not bring the card back when a later pass cannot see the reply", () => {
    t = makeTestDb();
    pass(
      {
        conversations: [{ source: "slack", externalId: "C1", name: "#atlas" }],
        observations: [
          {
            source: "slack",
            externalId: "C1/1794000002.100100",
            at: "2026-11-02T08:00:00.000Z",
            kind: "mention",
            actorName: "Priya Raman",
            text: "can you confirm the Q4 numbers?",
            context: "#atlas",
          },
        ],
      },
      MONDAY,
    );
    pass({ conversations: [{ source: "slack", externalId: "C1", mineAt: "2026-11-02T08:30:00.000Z" }], observations: [] }, FRIDAY);
    expect(open()).toEqual([]);

    // Scrolled up: this pass sees an older tail, and a pass after that sees none.
    pass({ conversations: [{ source: "slack", externalId: "C1", mineAt: "2026-11-01T08:00:00.000Z" }], observations: [] }, FRIDAY);
    expect(open()).toEqual([]);
    pass({ conversations: [{ source: "slack", externalId: "C1", name: "#atlas" }], observations: [] }, FRIDAY);
    expect(open()).toEqual([]);
  });
});
