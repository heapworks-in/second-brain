import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { readHelperToken } from "@/lib/activity-auth";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

const run = promisify(execFile);

/**
 * Where the bundled Chrome adaptor landed, and the token it needs.
 *
 * `SB_ADAPTORS_DIR` is set by the Tauri shell, which is the only thing that knows -- it is what
 * unpacked the extension out of the app bundle. An install managed by `scripts/brain.sh` has no
 * shell and so no bundled copy; the page then points at the repo instead of a path that is not
 * there.
 *
 * The token is returned to the page, and that is a smaller step than it looks: every route here
 * is guarded by `crossSite`, so a page on the open web cannot read this, and anything running
 * locally can already read the token file directly. What it buys is a Copy button in place of a
 * Terminal command, which is the whole difference between this being installable by somebody who
 * should never see a terminal and not.
 */
function adaptorDir(): string | null {
  const dir = process.env.SB_ADAPTORS_DIR?.trim();
  if (!dir) return null;
  return fs.existsSync(path.join(dir, "manifest.json")) ? dir : null;
}

export function GET(req: Request): Response {
  if (crossSite(req)) return forbidden();
  try {
    return NextResponse.json({ extensionPath: adaptorDir(), token: readHelperToken() });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Shows the folder in Finder, so "Load unpacked" has somewhere to be pointed at. */
export async function POST(req: Request): Promise<Response> {
  if (crossSite(req)) return forbidden();
  const dir = adaptorDir();
  if (!dir) return NextResponse.json({ error: "No bundled adaptor on this install" }, { status: 404 });
  try {
    await run("open", [dir]);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
