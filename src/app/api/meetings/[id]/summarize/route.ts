// Unlike its siblings, `[id]` here is a meeting *item* id -- the same id `actions` takes, not the
// calendar event id the parent route reads.
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { queueSummary } from "@/domain/meetings/summarize";
import { errorResponse, parseId } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const id = parseId((await ctx.params).id);
    queueSummary(getDb(), id);
    return NextResponse.json({ queued: true });
  } catch (err) {
    return errorResponse(err);
  }
}
