import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getFeedState, setFeedUrl, syncCalendarFeed } from "@/domain/activity";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ feedUrl: z.string().max(2048) }).strict();

/** The published calendar link the app polls, and how its last sync went. */
export async function GET(): Promise<Response> {
  try {
    const db = getDb();
    return NextResponse.json(getFeedState(db));
  } catch (err) {
    return errorResponse(err);
  }
}

/** Saving a link syncs it straight away, so the answer already says whether it worked. */
export async function PATCH(req: Request): Promise<Response> {
  try {
    // The server fetches whatever link is saved: no other site gets to choose it.
    if (crossSite(req)) return forbidden();
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const db = getDb();
    try {
      setFeedUrl(db, parsed.data.feedUrl);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
    const sync = await syncCalendarFeed(db, { log: (m) => console.log(`[calendar-feed] ${m}`) });
    return NextResponse.json({ ...getFeedState(db), sync });
  } catch (err) {
    return errorResponse(err);
  }
}
