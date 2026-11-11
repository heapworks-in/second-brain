import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { trackers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { deleteTracker, getTracker } from "@/domain/trackers/export";
import { crossSite, errorResponse, forbidden, parseId } from "@/lib/api";
import { nowIso } from "@/lib/time";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const Patch = z.object({ name: z.string().min(1).max(120).optional(), containerId: z.number().int().positive().nullable().optional() }).strict();

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  if (crossSite(req)) return forbidden();
  try {
    const id = parseId((await ctx.params).id);
    const parsed = Patch.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const db = getDb();
    if (!getTracker(db, id)) return NextResponse.json({ error: `Tracker ${id} not found` }, { status: 404 });
    const row = db.update(trackers).set({ ...parsed.data, updatedAt: nowIso() }).where(eq(trackers.id, id)).returning().get();
    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

/** `?rows=delete` takes the imported rows with it; the default leaves them as ordinary tasks.
 * The page asks which in those words, because both are things somebody means. */
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  if (crossSite(req)) return forbidden();
  try {
    const id = parseId((await ctx.params).id);
    const rows = new URL(req.url).searchParams.get("rows") === "delete" ? "delete" : "keep";
    return NextResponse.json(deleteTracker(getDb(), id, rows));
  } catch (err) {
    return errorResponse(err);
  }
}
