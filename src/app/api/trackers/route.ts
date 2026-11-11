import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { TASK_STATUSES } from "@/db/enums";
import { applyImport, previewImport } from "@/domain/trackers/import";
import { TRACKER_FIELDS } from "@/domain/trackers/mapping";
import { setIdentityNames } from "@/domain/trackers/identity";
import { listTrackers } from "@/domain/trackers/export";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    name: z.string().min(1).max(120),
    containerId: z.number().int().positive().nullable().default(null),
    sourceName: z.string().max(200).default(""),
    sheetName: z.string().max(120).default(""),
    headers: z.array(z.string()).min(1).max(100),
    rows: z.array(z.record(z.string(), z.string())).max(20_000),
    mapping: z.object({
      columns: z.partialRecord(z.enum(TRACKER_FIELDS), z.string()),
      theme: z.enum(["group", "container"]),
    }),
    statusMap: z.record(z.string(), z.enum(TASK_STATUSES)),
    identityNames: z.array(z.string().max(80)).max(10).default([]),
    trackerId: z.number().int().positive().optional(),
    /** True asks what would happen; false does it. One route, so the preview cannot drift from
     * the thing it is previewing. */
    dryRun: z.boolean().default(false),
  })
  .strict();

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json({ trackers: listTrackers(getDb()) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  if (crossSite(req)) return forbidden();
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const db = getDb();
    const { dryRun, ...input } = parsed.data;
    if (dryRun) return NextResponse.json({ plan: previewImport(db, input) });
    // Remembered before the import that needed them, so the next file does not ask again.
    if (input.identityNames.length > 0) setIdentityNames(db, input.identityNames);
    const out = applyImport(db, input);
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
