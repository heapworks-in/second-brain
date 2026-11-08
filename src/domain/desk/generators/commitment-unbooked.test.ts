import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { items } from "@/db/schema";
import { commitmentUnbooked } from "./commitment-unbooked";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");
const DAY_MS = 86_400_000;

function meeting(meta: Record<string, unknown>, over: Partial<typeof items.$inferInsert> = {}) {
  const createdAt = over.createdAt ?? NOW.toISOString();
  return t.db
    .insert(items)
    .values({ type: "meeting", title: "Platform weekly", meta: JSON.stringify(meta), createdAt, updatedAt: createdAt, ...over })
    .returning()
    .get();
}

const TWO_ACTIONS = {
  summary: {
    proposed_actions: [
      { title: "Send the migration plan to Priya", owner: "me", notes: "before Friday" },
      { title: "Book time with the auditors" },
    ],
  },
};

describe("commitmentUnbooked", () => {
  it("proposes each action the summariser wrote down and nobody booked", () => {
    t = makeTestDb();
    const item = meeting(TWO_ACTIONS);
    const out = commitmentUnbooked(t.db, NOW);
    expect(out.map((p) => p.title)).toEqual(["Send the migration plan to Priya", "Book time with the auditors"]);
    expect(out[0].sourceRef).toBe(`action:${item.id}:0`);
    expect(out[1].sourceRef).toBe(`action:${item.id}:1`);
    expect(out[0].detail).toBe("me, from Platform weekly today. Not booked.");
    expect(out[1].detail).toBe("From Platform weekly today. Not booked.");
  });

  /** One proposal per action, so booking one must leave the others exactly where they were. */
  it("drops only the action that has been booked", () => {
    t = makeTestDb();
    const item = meeting({ ...TWO_ACTIONS, acceptedActions: [0] });
    expect(commitmentUnbooked(t.db, NOW).map((p) => p.sourceRef)).toEqual([`action:${item.id}:1`]);
  });

  it("is quiet when every action is booked", () => {
    t = makeTestDb();
    meeting({ ...TWO_ACTIONS, acceptedActions: [0, 1] });
    expect(commitmentUnbooked(t.db, NOW)).toHaveLength(0);
  });

  it("is quiet about a meeting with no summary, and about an archived one", () => {
    t = makeTestDb();
    meeting({});
    meeting(TWO_ACTIONS, { archivedAt: NOW.toISOString() });
    expect(commitmentUnbooked(t.db, NOW)).toHaveLength(0);
  });

  it("skips an action the model proposed with no title rather than filing a blank card", () => {
    t = makeTestDb();
    meeting({ summary: { proposed_actions: [{ title: "   " }, { notes: "no title at all" }, { title: "Real one" }] } });
    expect(commitmentUnbooked(t.db, NOW).map((p) => p.title)).toEqual(["Real one"]);
  });

  it("indexes by position, so a blank action does not shift the ones after it", () => {
    t = makeTestDb();
    const item = meeting({ summary: { proposed_actions: [{ title: "" }, { title: "Second" }] } });
    expect(commitmentUnbooked(t.db, NOW)[0].sourceRef).toBe(`action:${item.id}:1`);
  });

  it("survives meta that is not the shape it should be", () => {
    t = makeTestDb();
    meeting({ summary: { proposed_actions: "proposed_actions but a string" } });
    expect(commitmentUnbooked(t.db, NOW)).toHaveLength(0);
  });

  /** The opposite decay to every other kind here: an action is cheapest to act on the day it was
   * said, and a fortnight later it has been done another way or quietly abandoned. */
  it("decays with age rather than growing, and keeps a floor", () => {
    t = makeTestDb();
    meeting(TWO_ACTIONS, { createdAt: NOW.toISOString() });
    const today = commitmentUnbooked(t.db, NOW)[0].urgency;
    t.cleanup();

    t = makeTestDb();
    meeting(TWO_ACTIONS, { createdAt: new Date(NOW.getTime() - 7 * DAY_MS).toISOString() });
    const week = commitmentUnbooked(t.db, NOW)[0];
    t.cleanup();

    t = makeTestDb();
    meeting(TWO_ACTIONS, { createdAt: new Date(NOW.getTime() - 90 * DAY_MS).toISOString() });
    const old = commitmentUnbooked(t.db, NOW)[0].urgency;

    expect(today).toBe(1);
    expect(week.urgency).toBeCloseTo(0.5);
    expect(week.detail).toBe("me, from Platform weekly 7 days ago. Not booked.");
    expect(old).toBe(0.15);
  });

  it("carries everything the commit needs", () => {
    t = makeTestDb();
    const item = meeting(TWO_ACTIONS, { containerId: null });
    expect(commitmentUnbooked(t.db, NOW)[0].payload).toMatchObject({
      itemId: item.id,
      index: 0,
      title: "Send the migration plan to Priya",
      notes: "before Friday",
      meetingTitle: "Platform weekly",
    });
  });
});
