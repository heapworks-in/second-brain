import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { createItem, updateItem } from "@/domain/items";
import { enqueueJob, listJobs, completeJob } from "@/jobs/queue";
import { MeetingError } from "./errors";
import { queueSummary, sweepMissingSummaries } from "./summarize";

function types(t: TestDb, itemId: number): string[] {
  return listJobs(t.db, { itemId }).map((j) => j.type);
}

/** An item with words on it. `createItem` takes no `extractedText`; the transcript job writes it. */
let db: TestDb;
function transcribed(type: "meeting" | "note", title: string, text: string, meta?: Record<string, unknown>) {
  const item = createItem(db.db, { type, title, meta });
  updateItem(db.db, item.id, { extractedText: text });
  return item;
}

describe("queueSummary", () => {
  let t: TestDb;
  beforeEach(() => ((t = makeTestDb()), (db = t)));
  afterEach(() => t.cleanup());

  it("queues a pass for a meeting that has a transcript", () => {
    const item = transcribed("meeting", "Standup", "we shipped it");
    queueSummary(t.db, item.id);
    expect(types(t, item.id)).toEqual(["summarize_meeting"]);
  });

  it("queues a pass for a meeting with notes but no transcript", () => {
    const item = createItem(t.db, { type: "meeting", title: "Standup", body: "agreed to ship" });
    queueSummary(t.db, item.id);
    expect(types(t, item.id)).toEqual(["summarize_meeting"]);
  });

  // The 7B model is minutes of work on a serial queue; two presses must not buy two passes.
  it("does not queue a second pass while one is still waiting", () => {
    const item = transcribed("meeting", "Standup", "we shipped it");
    queueSummary(t.db, item.id);
    queueSummary(t.db, item.id);
    expect(types(t, item.id)).toEqual(["summarize_meeting"]);
  });

  it("queues again once the previous pass has finished", () => {
    const item = transcribed("meeting", "Standup", "we shipped it");
    queueSummary(t.db, item.id);
    completeJob(t.db, listJobs(t.db, { itemId: item.id })[0].id);
    queueSummary(t.db, item.id);
    expect(types(t, item.id)).toEqual(["summarize_meeting", "summarize_meeting"]);
  });

  it("refuses a meeting with nothing on it to summarise", () => {
    const item = createItem(t.db, { type: "meeting", title: "Standup" });
    expect(() => queueSummary(t.db, item.id)).toThrow(MeetingError);
    expect(types(t, item.id)).toEqual([]);
  });

  it("refuses an item that is not a meeting, and one that is not there", () => {
    const note = transcribed("note", "Note", "words");
    expect(() => queueSummary(t.db, note.id)).toThrow(/meeting/i);
    expect(() => queueSummary(t.db, 9999)).toThrow(/not found/i);
  });
});

describe("sweepMissingSummaries", () => {
  let t: TestDb;
  beforeEach(() => ((t = makeTestDb()), (db = t)));
  afterEach(() => t.cleanup());

  /** The hole this exists to heal: `transcribe_final` used to queue a summary only when the
   *  model happened to be installed as it finished, so a meeting recorded during the download
   *  never got one and nothing ever looked again. */
  it("queues a summary for a transcribed meeting that was never offered one", () => {
    const item = transcribed("meeting", "Platform sync", "we chose Tuesday");
    enqueueJob(t.db, "transcribe_final", { itemId: item.id }, item.id);

    expect(sweepMissingSummaries(t.db)).toBe(1);
    expect(types(t, item.id)).toEqual(["transcribe_final", "summarize_meeting"]);
  });

  it("leaves a meeting that already has a summary alone", () => {
    const item = transcribed("meeting", "Platform sync", "we chose Tuesday", {
      summary: { summary: "Tuesday it is", decisions: [], proposed_actions: [] },
    });
    expect(sweepMissingSummaries(t.db)).toBe(0);
    expect(types(t, item.id)).toEqual([]);
  });

  // A pass that was offered and failed has a reason recorded; re-running a wedged transcript on
  // every boot would cost ten minutes of model time a restart and help nobody.
  it("leaves a meeting whose summary pass already ran alone", () => {
    const item = transcribed("meeting", "Platform sync", "we chose Tuesday");
    const job = enqueueJob(t.db, "summarize_meeting", { itemId: item.id }, item.id);
    completeJob(t.db, job.id);

    expect(sweepMissingSummaries(t.db)).toBe(0);
    expect(types(t, item.id)).toEqual(["summarize_meeting"]);
  });

  it("leaves a meeting with no words on it alone, and ignores other item types", () => {
    createItem(t.db, { type: "meeting", title: "Never recorded" });
    transcribed("note", "Note", "words");
    expect(sweepMissingSummaries(t.db)).toBe(0);
  });
});
