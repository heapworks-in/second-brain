import { getDb } from "@/db/client";
import { getTracker, trackerSheet } from "@/domain/trackers/export";
import { writeWorkbook } from "@/domain/trackers/sheet";
import { errorResponse, parseId } from "@/lib/api";

export const dynamic = "force-dynamic";

/** The tracker as an .xlsx file: its own columns, its own order, plus the `SB ID` column that
 * makes the next re-import exact. A download, so it is a GET -- the browser does the rest. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const id = parseId((await ctx.params).id);
    const db = getDb();
    const tracker = getTracker(db, id);
    if (!tracker) return new Response("Not found", { status: 404 });
    const buffer = await writeWorkbook(trackerSheet(db, id));
    const name = `${tracker.slug}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new Response(new Uint8Array(buffer), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${name}"`,
        "content-length": String(buffer.byteLength),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
