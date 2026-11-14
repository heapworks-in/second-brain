import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { isPaused } from "@/domain/activity";
import { ingestObservations } from "@/domain/observations";
import { requireHelperToken } from "@/lib/activity-auth";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

/** One POST's worth. A backfill of a year of mentions is many calls, not one enormous one. */
const MAX_BATCH = 500;

const Observation = z.object({
  source: z.string().min(1).max(32),
  externalId: z.string().min(1).max(256),
  at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid timestamp"),
  kind: z.string().min(1).max(32),
  actorHandle: z.string().max(128).nullish(),
  actorName: z.string().max(256).nullish(),
  text: z.string().max(8000).optional(),
  url: z.string().max(2048).nullish(),
  context: z.string().max(256).nullish(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const Body = z.object({ observations: z.array(Observation).min(1).max(MAX_BATCH) });

/**
 * An adaptor's only way in.
 *
 * Adaptors live outside this repo -- `sb-adaptors`, one folder per external tool -- and talk to
 * the app exactly the way the activity helper does: loopback, a bearer token from the data
 * directory, a narrow validated payload, and policy handed back in the response rather than
 * configured twice. `paused` is the app's own capture pause, so one switch covers every source
 * and an adaptor never has to be told separately to stop.
 *
 * The browser extension is a cross-origin caller, which the helper is not, so this route answers
 * preflight. The token stays the gate: the origin is only allowed to ask.
 */
function cors(origin: string | null): Record<string, string> {
  // Only extensions. A page on the open web must not be able to reach this even to be refused,
  // and `*` would let any site in a browser probe the port for a response shape.
  const allowed = origin?.startsWith("chrome-extension://") ? origin : "null";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

export function OPTIONS(req: Request): Response {
  return new NextResponse(null, { status: 204, headers: cors(req.headers.get("origin")) });
}

export async function POST(req: Request): Promise<Response> {
  const headers = cors(req.headers.get("origin"));
  const denied = requireHelperToken(req);
  if (denied) {
    for (const [k, v] of Object.entries(headers)) denied.headers.set(k, v);
    return denied;
  }
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400, headers });
    const db = getDb();
    const paused = isPaused(db);
    // Reported, not enforced by silence: an adaptor that keeps posting while paused gets a
    // truthful zero back and can stop, and nothing is written in the meantime.
    const result = paused ? { accepted: 0, updated: 0 } : ingestObservations(db, parsed.data.observations);
    return NextResponse.json({ ...result, paused }, { headers });
  } catch (err) {
    const res = errorResponse(err);
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  }
}
