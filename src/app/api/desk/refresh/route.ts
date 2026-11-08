import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { enqueueJob } from "@/jobs/queue";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Sweep now rather than at the next quarter hour. Queues the same `desk` job the interval does,
 * so the button and the timer can never do different work.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    if (crossSite(req)) return forbidden();
    const job = enqueueJob(getDb(), "desk", {});
    return NextResponse.json({ queued: job.id }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
