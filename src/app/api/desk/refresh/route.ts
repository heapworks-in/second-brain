import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { sweepDesk } from "@/domain/desk/sweep";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Sweep now rather than at the next quarter hour.
 *
 * Runs the sweep rather than queueing it. It used to queue the same job the interval does, which
 * read as the tidier thing -- but the worker polls once a second, so the request was answered
 * before the job had been claimed, and the client then re-read the desk it already had. A button
 * that provably changes nothing is a button you stop pressing. `sweepDesk` is the same function
 * the job runs, so the two still cannot drift apart.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    if (crossSite(req)) return forbidden();
    const result = sweepDesk(getDb(), new Date(), (m) => console.log(m));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
