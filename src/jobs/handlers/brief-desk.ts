import type { DB } from "@/db/client";
import type { EmbedProvider } from "@/providers/embed/types";
import type { ChatProvider } from "@/providers/chat";
import { getChatProvider } from "@/providers/chat";
import { briefProposals } from "@/domain/knowledge/brief";
import type { JobHandler } from "@/jobs/worker";

/**
 * Look up what the knowledge base already knows about the cards on the desk.
 *
 * A job rather than part of the sweep, for the reason every model call here is a job: the sweep is
 * synchronous and must stay fast enough to run behind a button press, and retrieval is a model
 * round trip per card. Queued by the sweep, so the two cannot drift.
 */
export function createBriefDeskHandler(deps: { db: DB; embed: EmbedProvider | null; chat?: ChatProvider | null }): JobHandler {
  return async () => {
    const chat = deps.chat !== undefined ? deps.chat : await getChatProvider();
    const out = await briefProposals(deps.db, { embed: deps.embed, chat });
    if (out.briefed) console.log(`[brief_desk] attached context to ${out.briefed} card(s)`);
  };
}
