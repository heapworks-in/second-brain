import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { eq } from "drizzle-orm";
import { observations } from "@/db/schema";
import { ingestObservations, sweepObservationText } from "@/domain/observations";
import { enqueueJob } from "@/jobs/queue";
import type { ChatProvider } from "@/providers/chat";
import { createJudgeMessageHandler } from "./judge-message";

let t: TestDb;
beforeEach(() => { t = makeTestDb(); });
afterEach(() => t.cleanup());

const NOW = new Date("2026-11-14T12:00:00.000Z");

function fakeChat(answer: unknown): ChatProvider {
  return { structured: vi.fn().mockResolvedValue(answer) };
}

function message(text: string, over: Record<string, unknown> = {}): number {
  ingestObservations(
    t.db,
    [
      {
        source: "slack",
        externalId: "C1/1794429455.100200",
        at: "2026-11-01T09:00:00.000Z",
        kind: "mention",
        actorName: "Priya Raman",
        text,
        context: "#project-atlas",
        ...over,
      },
    ],
    NOW,
  );
  return t.db.select().from(observations).get()!.id;
}

const meta = (id: number) => JSON.parse(t.db.select().from(observations).where(eq(observations.id, id)).get()!.meta);

describe("createJudgeMessageHandler", () => {
  it("records a verdict and what is being asked for", async () => {
    const id = message("hey -- sorry to keep bothering you, could you send the staging creds?");
    const handler = createJudgeMessageHandler({ db: t.db, chat: fakeChat({ ask: true, what: "send the staging credentials" }) });
    await handler(enqueueJob(t.db, "judge_message", { observationId: id }));
    expect(meta(id).judge).toEqual({ ask: true, what: "send the staging credentials" });
  });

  it("records a refusal to call it an ask", async () => {
    const id = message("thanks, that's great");
    const handler = createJudgeMessageHandler({ db: t.db, chat: fakeChat({ ask: false }) });
    await handler(enqueueJob(t.db, "judge_message", { observationId: id }));
    expect(meta(id).judge).toEqual({ ask: false });
  });

  /* Fails open, everywhere. A generator reads a missing verdict as "assume it is an ask", so
   * these paths leave the desk exactly as it was before any model existed -- a judgement may
   * improve a card, never make somebody waiting on you disappear. */
  it("writes nothing when there is no model on this machine", async () => {
    const id = message("could you confirm the numbers?");
    await createJudgeMessageHandler({ db: t.db, chat: null })(enqueueJob(t.db, "judge_message", { observationId: id }));
    expect(meta(id).judge).toBeUndefined();
  });

  it("writes nothing when the model answers something that is not a verdict", async () => {
    const id = message("could you confirm the numbers?");
    const handler = createJudgeMessageHandler({ db: t.db, chat: fakeChat({ ask: "probably" }) });
    await expect(handler(enqueueJob(t.db, "judge_message", { observationId: id }))).rejects.toThrow();
    expect(meta(id).judge).toBeUndefined();
  });

  it("keeps whatever meta already held", async () => {
    const id = message("could you confirm the numbers?", { meta: { seenIn: "activity" } });
    const handler = createJudgeMessageHandler({ db: t.db, chat: fakeChat({ ask: true }) });
    await handler(enqueueJob(t.db, "judge_message", { observationId: id }));
    expect(meta(id)).toMatchObject({ seenIn: "activity", judge: { ask: true } });
  });

  /* The job can outlive the words: the TTL sweep empties `text` after fourteen days, and a model
   * handed an empty message would invent a verdict about nothing. */
  it("does not ask about a message whose text has been swept", async () => {
    const id = message("could you confirm the numbers?");
    sweepObservationText(t.db, new Date("2026-12-01T00:00:00.000Z"));
    const chat = fakeChat({ ask: true });
    await createJudgeMessageHandler({ db: t.db, chat })(enqueueJob(t.db, "judge_message", { observationId: id }));
    expect(chat.structured).not.toHaveBeenCalled();
    expect(meta(id).judge).toBeUndefined();
  });

  it("does not throw when the observation is gone", async () => {
    const job = enqueueJob(t.db, "judge_message", { observationId: 9999 });
    await expect(createJudgeMessageHandler({ db: t.db, chat: fakeChat({ ask: true }) })(job)).resolves.toBeUndefined();
  });
});
