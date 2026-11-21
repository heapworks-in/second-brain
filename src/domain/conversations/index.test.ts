import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { conversationForMessage, kindFromExternalId, upsertConversation } from ".";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-14T12:00:00.000Z");

describe("kindFromExternalId", () => {
  it("reads Slack's own convention off the id", () => {
    expect(kindFromExternalId("C0A1B2C3D")).toBe("channel");
    expect(kindFromExternalId("D04F5G6H7")).toBe("dm");
    expect(kindFromExternalId("G01X2Y3Z4")).toBe("group");
  });
});

describe("upsertConversation", () => {
  it("records what the first pass saw", () => {
    t = makeTestDb();
    const row = upsertConversation(t.db, { source: "slack", externalId: "C1", name: "#atlas", mineAt: "2026-11-01T09:00:00.000Z" }, NOW);
    expect(row.kind).toBe("channel");
    expect(row.name).toBe("#atlas");
    expect(row.mineAt).toBe("2026-11-01T09:00:00.000Z");
    expect(row.theirsAt).toBeNull();
  });

  it("moves a timestamp forwards", () => {
    t = makeTestDb();
    upsertConversation(t.db, { source: "slack", externalId: "C1", theirsAt: "2026-11-01T09:00:00.000Z" }, NOW);
    const row = upsertConversation(t.db, { source: "slack", externalId: "C1", theirsAt: "2026-11-05T09:00:00.000Z" }, NOW);
    expect(row.theirsAt).toBe("2026-11-05T09:00:00.000Z");
  });

  /* The whole reason this function exists rather than a plain update. A reader sees a viewport:
   * the pass with the reply on screen reports it, and the next pass -- scrolled up, or looking at
   * another channel -- reports an older tail. Taking the newer report as truth would let that pass
   * say the reply had un-arrived, putting a card back on the desk for something answered days ago
   * and taking it away again thirty seconds later, forever. */
  it("never moves one backwards, so a later pass cannot un-see a reply", () => {
    t = makeTestDb();
    upsertConversation(t.db, { source: "slack", externalId: "C1", theirsAt: "2026-11-05T09:00:00.000Z" }, NOW);
    const row = upsertConversation(t.db, { source: "slack", externalId: "C1", theirsAt: "2026-11-01T09:00:00.000Z" }, NOW);
    expect(row.theirsAt).toBe("2026-11-05T09:00:00.000Z");
  });

  it("does not let a pass that could not read the name erase one", () => {
    t = makeTestDb();
    upsertConversation(t.db, { source: "slack", externalId: "C1", name: "#atlas" }, NOW);
    expect(upsertConversation(t.db, { source: "slack", externalId: "C1" }, NOW).name).toBe("#atlas");
  });

  it("ignores an unparseable timestamp rather than storing it", () => {
    t = makeTestDb();
    const row = upsertConversation(t.db, { source: "slack", externalId: "C1", mineAt: "not a date" }, NOW);
    expect(row.mineAt).toBeNull();
  });
});

describe("conversationForMessage", () => {
  /* An Activity row hands over a channel id and nothing else, weeks before anybody opens that
   * channel. Filing the mention against the conversation anyway is what lets the card expire on
   * its own the day a reply finally happens there. */
  it("derives the conversation from a message id alone", () => {
    t = makeTestDb();
    const row = conversationForMessage(t.db, "slack", "C0A1B2C3D/1794429455.100200", NOW);
    expect(row?.externalId).toBe("C0A1B2C3D");
    expect(row?.kind).toBe("channel");
  });

  it("returns nothing for an id with no conversation in it, rather than inventing one", () => {
    t = makeTestDb();
    expect(conversationForMessage(t.db, "jira", "ISSUE-4821", NOW)).toBeNull();
  });
});
