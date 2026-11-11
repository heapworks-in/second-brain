import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { identityNames, setIdentityNames } from "@/domain/trackers/identity";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({ names: z.array(z.string().max(80)).max(10) }).strict();

/** Which names in a spreadsheet's owner column are me. */
export async function GET(): Promise<Response> {
  try {
    return NextResponse.json({ names: identityNames(getDb()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request): Promise<Response> {
  if (crossSite(req)) return forbidden();
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    return NextResponse.json({ names: setIdentityNames(getDb(), parsed.data.names) });
  } catch (err) {
    return errorResponse(err);
  }
}
