// `[id]` here is a meeting item id (`items.id`), not a calendar event id.
// The parent `/api/meetings/[id]` takes a calendar event id instead: two id spaces, one path prefix.
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { acceptMeetingAction } from "@/domain/meetings/actions";
import { blocksByTask } from "@/domain/blocks";
import { errorResponse, parseId, serializeTask, taskBlockWindow } from "@/lib/api";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** The row's own title wins: the person is allowed to reword what the model proposed. */
const AcceptActionBody = z.object({ index: z.number().int().min(0), title: z.string().min(1) }).strict();

/**
 * Accept one proposed action. The task is born in the meeting's own home and remembers the
 * meeting it came from, and the index is recorded so the row stays marked across a reload.
 *
 * The work is `acceptMeetingAction`, shared with the desk's `commitment_unbooked` card: the
 * index bookkeeping is the only thing stopping the two surfaces from booking the same action
 * twice, so there must be exactly one copy of it. It is idempotent on the index, which is what
 * makes a second click, a stale tab or a retry cost one task rather than two.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const id = parseId((await ctx.params).id);
    const parsed = AcceptActionBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

    const db = getDb();
    const { task, created } = acceptMeetingAction(db, id, parsed.data.index, parsed.data.title);
    const blocks = blocksByTask(db, [task.id], taskBlockWindow()).get(task.id) ?? [];
    // 200 for an index already booked: the answer is the task that exists, not a new one.
    return NextResponse.json({ task: serializeTask(task, blocks) }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
