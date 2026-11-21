import { z } from "zod";
import { eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import { observations } from "@/db/schema";
import { getConversation } from "@/domain/conversations";
import { getChatProvider, type ChatProvider } from "@/providers/chat";
import type { JobHandler } from "@/jobs/worker";
import { nowIso } from "@/lib/time";

const Payload = z.object({ observationId: z.number() });

/**
 * What the model is asked to decide, and nothing more.
 *
 * Deliberately not "how urgent is this" or "what should I do about it". Urgency is a function of
 * how long something has waited and the desk already computes it from the clock, which is a
 * number that cannot be wrong; asking a 26B model to feel strongly about a message instead would
 * make the ordering of the day depend on its mood. The two things it is asked are the two things
 * a regular expression genuinely cannot do: is this actually asking me for something, and if so,
 * what -- said once, plainly, so a card can carry it instead of carrying the first ninety
 * characters of a greeting.
 */
const Verdict = z.object({
  ask: z.boolean(),
  what: z.string().max(120).optional(),
});

const SYSTEM = [
  "You read one message from a work chat and decide whether it is asking the reader for something.",
  "An ask is a request for an answer, a decision, a file, a review, or an action.",
  "These are NOT asks: greetings, thanks, acknowledgements ('sounds good', 'will do'), announcements,",
  "status updates nobody has to act on, and jokes. A question mark does not make something an ask;",
  "'anyone else seeing this?' in a room full of people is not a request to the reader.",
  "If it is an ask, say what is wanted in one short phrase, starting with a verb where it reads",
  "naturally -- 'send the staging credentials', 'approve the migration PR'. Never copy the message",
  "back. If it is not an ask, leave the phrase out.",
].join(" ");

/**
 * Read one message, with what is known of where it was said, and record a verdict on it.
 *
 * Queued at ingest, once per message, and that timing is forced rather than chosen: raw text is
 * dropped after fourteen days, so every judgement that reads the words has to be reached while
 * they still exist. It is also a round trip to a local model, which is why it is a job with a
 * retry rather than something a generator does -- a sweep runs every quarter of an hour and would
 * re-ask the same question about the same message for as long as it sat there.
 *
 * Fails open at every step. No model installed, a model that cannot be reached, an answer that
 * does not fit the schema: all of them leave `meta.judge` unwritten, and both generators read a
 * missing verdict as "assume it is an ask". A judgement is allowed to improve a card. It is never
 * allowed to be the reason somebody waiting on you disappears off the desk.
 */
export interface JudgeMessageDeps {
  db: DB;
  /** Injected by the tests; `undefined` means "resolve whatever this machine has". */
  chat?: ChatProvider | null;
}

export function createJudgeMessageHandler(deps: JudgeMessageDeps): JobHandler {
  return async (job) => {
    const { observationId } = Payload.parse(JSON.parse(job.payload));
    const row = deps.db.select().from(observations).where(eq(observations.id, observationId)).get();
    // Gone, or its text already swept: nothing to read, and nothing to record about it.
    if (!row || row.text.trim() === "") return;

    const provider = deps.chat !== undefined ? deps.chat : await getChatProvider();
    if (!provider) return;

    const conversation = row.conversationId !== null ? getConversation(deps.db, row.conversationId) : undefined;
    const where = row.context ?? conversation?.name ?? null;
    const who = row.kind === "sent" ? "the reader" : (row.actorName ?? row.actorHandle ?? "someone");
    // Parsed again on the way out, not just declared on the way in. The schema is the grammar a
    // local runtime is *asked* to constrain itself to, and whether it did is the runtime's claim,
    // not a fact -- so the answer is checked here, where a bad one throws and the job retries,
    // rather than written into meta for a generator to read as a verdict.
    const verdict = Verdict.parse(
      await provider.structured({
        system: SYSTEM,
        user: [
          where ? `Where: ${where}${conversation ? ` (a ${conversation.kind})` : ""}` : null,
          `From: ${who}`,
          row.kind === "sent" ? "This is a message the reader sent; decide whether they asked for something." : null,
          "",
          "Message:",
          row.text.slice(0, 2000),
        ]
          .filter((line) => line !== null)
          .join("\n"),
        schema: Verdict,
        name: "record_message_verdict",
        description: "Record whether this message asks the reader for something, and what for.",
      }),
    );

    // Merged into whatever meta already holds, never written over it: `answeredAt` and anything a
    // later adaptor reports live in the same object.
    const meta = (() => {
      try {
        return { ...(JSON.parse(row.meta) as Record<string, unknown>) };
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    meta.judge = { ask: verdict.ask, ...(verdict.what?.trim() ? { what: verdict.what.trim() } : {}) };
    deps.db
      .update(observations)
      .set({ meta: JSON.stringify(meta), updatedAt: nowIso() })
      .where(eq(observations.id, row.id))
      .run();
  };
}
