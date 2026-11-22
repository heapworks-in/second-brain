import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { loadEvalSeed, runEval, runRefusalEval } from "@/domain/knowledge";
import { unindexedItems } from "@/domain/library/watch";
import { getChatProvider } from "@/providers/chat";
import { getEmbedProvider } from "@/server/providers";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Score the knowledge base against a fixed set of questions.
 *
 * Two numbers that answer different questions, which is why they are not averaged into one.
 * Retrieval is deterministic and free, so it can be run on every change and says whether the
 * right documents come back at all. Refusal needs the model and a round trip per case, and says
 * whether the system declines what the corpus does not cover -- the thing that makes a knowledge
 * base worth having rather than a confident stranger talking about your work.
 *
 * Nothing is recorded. An eval that writes to `ask_log` would feed its own questions back into
 * the ranker it is measuring, and the measurement would start moving the thing it measures.
 *
 * `unindexed` is reported alongside the scores because it invalidates them. A document holding
 * text no chunk was built from cannot be retrieved by any question, so a case about it fails for
 * a reason that has nothing to do with ranking -- and every case *not* about it passes while the
 * document stays invisible. It should always be empty; the sweep heals it within two minutes.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    if (crossSite(req)) return forbidden();
    const seed = loadEvalSeed();
    if (seed.missing) return NextResponse.json({ error: seed.missing }, { status: 404 });

    const db = getDb();
    const embed = getEmbedProvider();
    const retrieval = await runEval(db, embed, seed.retrieval);
    const chat = await getChatProvider();
    // Skipped rather than scored zero when there is no model: a machine without one refuses
    // everything, and calling that a perfect refusal rate would be a lie told in a number.
    const refusal = chat ? await runRefusalEval(db, { embed, chat }, seed.refusal) : null;
    return NextResponse.json({
      cases: seed.retrieval.length,
      refusalCases: seed.refusal.length,
      unindexed: unindexedItems(db, 50),
      retrieval,
      refusal,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
