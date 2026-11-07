import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { addBlock, appendBlock } from "@/domain/blocks";
import { errorResponse, serializeBlock } from "@/lib/api";
import { PostBlockBody } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Puts one session on the timeline, either at the time the caller names or — `at: "next-free"` —
 * in the first free time on the day it names. */
export async function POST(req: Request): Promise<Response> {
  try {
    const parsed = PostBlockBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const body = parsed.data;
    const db = getDb();
    const block = "at" in body ? appendBlock(db, body) : addBlock(db, body);
    return NextResponse.json(serializeBlock(block), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
