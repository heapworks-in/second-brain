import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { deskPayload } from "@/domain/desk";
import { decideProposal, undoProposal } from "@/domain/desk/decide";
import { crossSite, errorResponse, forbidden, parseId } from "@/lib/api";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ decision: z.enum(["accept", "snooze", "dismiss"]) }).strict();

/**
 * Answer one card. The reply carries both what happened and the desk as it now stands, so the
 * page advances to the next card on one round trip rather than answering and then re-asking.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    if (crossSite(req)) return forbidden();
    const id = parseId((await ctx.params).id);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

    const db = getDb();
    const now = new Date();
    const decided = decideProposal(db, id, parsed.data.decision, now);
    return NextResponse.json({
      label: decided.label,
      href: decided.href,
      // Only an accepted proposal can be taken back: a snooze expires by itself and a dismissal
      // is a judgement, both of which can be revisited without an eight-second window.
      undoable: decided.proposal.state === "accepted",
      desk: deskPayload(db, now),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Take back an acceptance, while the line offering it is still on screen. */
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  try {
    if (crossSite(req)) return forbidden();
    const id = parseId((await ctx.params).id);
    const db = getDb();
    const now = new Date();
    const undone = undoProposal(db, id);
    // Not an error when there is nothing to undo: the offer expired, or the server restarted,
    // and there is nothing the person pressing it can do about either.
    return NextResponse.json({ undone: undone !== null, desk: deskPayload(db, now) });
  } catch (err) {
    return errorResponse(err);
  }
}
