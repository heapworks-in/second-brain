import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import type { DB } from "@/db/client";
import { observations } from "@/db/schema";
import { createTask } from "@/domain/tasks";
import { classifyKind, ingestObservations, linkObservationToTask, openObservations, sweepObservationText } from "./index";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-14T12:00:00.000Z");

function obs(over: Partial<Parameters<typeof ingestObservations>[1][number]> = {}) {
  return {
    source: "slack",
    externalId: "T1/C1/1731600000.000100",
    at: "2026-11-01T09:00:00.000Z",
    kind: "mention",
    actorHandle: "priya",
    actorName: "Priya Raman",
    text: "can you confirm the Q4 numbers?",
    url: "https://app.slack.com/client/T1/C1/p1731600000000100",
    context: "#project-atlas",
    ...over,
  };
}

describe("ingestObservations", () => {
  it("inserts a batch", () => {
    t = makeTestDb();
    const r = ingestObservations(t.db, [obs(), obs({ externalId: "T1/C1/2" })], NOW);
    expect(r).toEqual({ accepted: 2, updated: 0 });
  });

  it("updates rather than duplicating when a backfill reads the same message twice", () => {
    // The scroll back through Slack's Activity view overlaps itself by design, so the second
    // pass over the same mention has to be an update or every backfill doubles the desk.
    t = makeTestDb();
    ingestObservations(t.db, [obs()], NOW);
    const r = ingestObservations(t.db, [obs({ text: "edited" })], NOW);
    expect(r).toEqual({ accepted: 0, updated: 1 });
    const rows = t.db.select().from(observations).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("edited");
  });

  it("keeps the task link when the same message is read again", () => {
    // Otherwise re-running a backfill would un-answer every ask already dealt with.
    t = makeTestDb();
    ingestObservations(t.db, [obs()], NOW);
    const task = createTask(t.db, { title: "Confirm Q4" });
    const row = t.db.select().from(observations).all()[0];
    linkObservationToTask(t.db, row.id, task.id);
    ingestObservations(t.db, [obs({ text: "again" })], NOW);
    expect(t.db.select().from(observations).all()[0].taskId).toBe(task.id);
  });

  it("keeps the message's own timestamp, not the import's", () => {
    // The whole backfill turns on this: urgency grows with the wait, so a three-week-old ask
    // stamped with import time would arrive brand new and sort below today's noise.
    t = makeTestDb();
    ingestObservations(t.db, [obs()], NOW);
    expect(t.db.select().from(observations).all()[0].at).toBe("2026-11-01T09:00:00.000Z");
  });
});

describe("openObservations", () => {
  it("returns only what has no task, oldest first", () => {
    t = makeTestDb();
    ingestObservations(t.db, [obs({ externalId: "a", at: "2026-11-03T09:00:00.000Z" }), obs({ externalId: "b", at: "2026-11-01T09:00:00.000Z" }), obs({ externalId: "c" })], NOW);
    const rows = t.db.select().from(observations).all();
    linkObservationToTask(t.db, rows.find((r) => r.externalId === "c")!.id, createTask(t.db, { title: "done" }).id);
    expect(openObservations(t.db, 10).map((r) => r.externalId)).toEqual(["b", "a"]);
  });
});

describe("sweepObservationText", () => {
  it("drops raw text past the TTL but keeps the row", () => {
    t = makeTestDb();
    ingestObservations(t.db, [obs({ at: "2026-10-01T09:00:00.000Z" })], NOW);
    expect(sweepObservationText(t.db, NOW)).toBe(1);
    const row = t.db.select().from(observations).all()[0];
    expect(row.text).toBe("");
    // The row survives so a later backfill cannot re-propose a message already dismissed.
    expect(row.externalId).toBe("T1/C1/1731600000.000100");
  });

  it("keeps the text of anything accepted", () => {
    t = makeTestDb();
    ingestObservations(t.db, [obs({ at: "2026-10-01T09:00:00.000Z" })], NOW);
    const row = t.db.select().from(observations).all()[0];
    linkObservationToTask(t.db, row.id, createTask(t.db, { title: "Confirm Q4" }).id);
    expect(sweepObservationText(t.db, NOW)).toBe(0);
    expect(t.db.select().from(observations).all()[0].text).not.toBe("");
  });

  it("leaves anything inside the window alone", () => {
    t = makeTestDb();
    ingestObservations(t.db, [obs({ at: "2026-11-10T09:00:00.000Z" })], NOW);
    expect(sweepObservationText(t.db, NOW)).toBe(0);
  });
});

describe("classifyKind", () => {
  it("marks a message addressed to the room, not to you", () => {
    // Slack's Activity view lists @channel announcements beside genuine mentions. A real
    // workspace's view was eleven consecutive job-posting broadcasts and no personal ask at all.
    for (const opener of ["@channel", "@here", "@everyone", "  @Channel", "@HERE everyone look"]) {
      expect(classifyKind("mention", `${opener} new job posted`)).toBe("broadcast");
    }
  });

  it("leaves a real mention alone", () => {
    expect(classifyKind("mention", "can you confirm the Q4 numbers?")).toBe("mention");
    expect(classifyKind("dm", "@priya and I discussed @channel strategy")).toBe("dm");
    expect(classifyKind("mention", undefined)).toBe("mention");
  });

  it("does not read my own announcement as somebody addressing a room", () => {
    // The rule is about other people's messages. Mine opening with @here is still a question I am
    // waiting on an answer to, and classifying it as a broadcast would drop it from both halves.
    expect(classifyKind("sent", "@here anyone know where the staging creds live?")).toBe("sent");
  });

  it("decides at ingest, so the verdict outlives the text", () => {
    t = makeTestDb();
    ingestObservations(t.db, [obs({ text: "@channel new job posted" })], NOW);
    const [row] = t.db.select().from(observations).all();
    expect(row.kind).toBe("broadcast");

    // The words it was judged on are dropped after the TTL; the verdict must not be re-derivable
    // from an empty string, or day fifteen would quietly promote an announcement to an ask.
    sweepObservationText(t.db, new Date("2026-12-14T12:00:00.000Z"));
    const [swept] = t.db.select().from(observations).all();
    expect(swept.text).toBe("");
    expect(swept.kind).toBe("broadcast");
  });
});

describe("meta", () => {
  const sent = (meta?: Record<string, unknown>) => ({
    source: "slack",
    externalId: "C1/1794429455.856259",
    at: "2026-11-01T09:00:00.000Z",
    kind: "sent",
    text: "any update on the staging credentials?",
    meta,
  });
  const stored = (db: DB) => JSON.parse(db.select().from(observations).all()[0].meta) as Record<string, unknown>;

  it("keeps a fact a later pass did not repeat", () => {
    // A reader sees a conversation through a viewport. The pass that renders the reply reports it;
    // the next one may not, and must not be able to say the reply un-arrived -- that would flap a
    // card on and off the desk every half minute for a question answered days ago.
    t = makeTestDb();
    ingestObservations(t.db, [sent({ answeredAt: "2026-11-02T10:00:00.000Z" })]);
    ingestObservations(t.db, [sent()]);
    expect(stored(t.db).answeredAt).toBe("2026-11-02T10:00:00.000Z");
  });

  it("still takes a new value for a key it already had", () => {
    t = makeTestDb();
    ingestObservations(t.db, [sent({ answeredAt: "2026-11-02T10:00:00.000Z" })]);
    ingestObservations(t.db, [sent({ answeredAt: "2026-11-03T10:00:00.000Z" })]);
    expect(stored(t.db).answeredAt).toBe("2026-11-03T10:00:00.000Z");
  });
});
