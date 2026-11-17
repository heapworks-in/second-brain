import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { identityNames } from "@/domain/trackers/identity";
import { AFK_SECONDS, ingestHeartbeat, isPaused, listExclusions, recordHelperSeen } from "@/domain/activity";
import { requireHelperToken } from "@/lib/activity-auth";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Invalid timestamp"),
  afk: z.boolean().optional(),
  paused: z.boolean().optional(),
  appId: z.string().nullable().optional(),
  appName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  idleSeconds: z.number().nonnegative().optional(),
  helper: z
    .object({
      version: z.string(),
      permissions: z.object({ accessibility: z.boolean(), calendar: z.boolean(), automation: z.record(z.string(), z.boolean()) }),
    })
    .optional(),
});

export async function POST(req: Request): Promise<Response> {
  const denied = requireHelperToken(req);
  if (denied) return denied;
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const db = getDb();
    const hb = parsed.data;
    recordHelperSeen(db, hb.at, hb.helper);
    const paused = isPaused(db);
    if (!paused && !hb.paused) {
      const afk = hb.afk === true || (hb.idleSeconds ?? 0) >= AFK_SECONDS;
      ingestHeartbeat(db, { at: hb.at, afk, appId: hb.appId, appName: hb.appName, title: hb.title, url: hb.url });
    }
    const ex = listExclusions(db);
    return NextResponse.json({
      exclusions: {
        apps: ex.filter((e) => e.kind === "app").map((e) => e.pattern),
        domains: ex.filter((e) => e.kind === "domain").map((e) => e.pattern),
      },
      paused,
      // Who the helper should treat as me when it reads a conversation in Slack. Handed back as
      // policy for the same reason the exclusions are: the helper would otherwise need its own
      // copy of a list that already exists here, and the two would drift. The same list a tracker
      // import matches an Owner column against -- one answer to "how is my name written".
      identities: identityNames(db),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
