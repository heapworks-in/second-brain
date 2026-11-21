import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ask, rateAsk } from "@/domain/knowledge";
import { getChatProvider } from "@/providers/chat";
import { getEmbedProvider } from "@/server/providers";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

const Question = z.object({ question: z.string().min(1).max(2000) });
const Rating = z.object({ askId: z.number().int().positive(), useful: z.boolean() });

/**
 * Ask the knowledge base something.
 *
 * The front door, and mostly a debugging surface: a box you have to remember to come and type in
 * does not automate anything, and the same `ask` is meant to be called by the things that bring
 * work to you rather than wait for you. It is here because a retrieval path you cannot interrogate
 * by hand is one you cannot fix, and because the questions it cannot answer are the most useful
 * thing the log collects.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    if (crossSite(req)) return forbidden();
    const parsed = Question.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const answered = await ask(getDb(), { embed: getEmbedProvider(), chat: await getChatProvider() }, parsed.data.question);
    return NextResponse.json(answered);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Say whether an answer was any good -- the one thing here that asks for a human. */
export async function PATCH(req: Request): Promise<Response> {
  try {
    if (crossSite(req)) return forbidden();
    const parsed = Rating.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    rateAsk(getDb(), parsed.data.askId, parsed.data.useful);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
