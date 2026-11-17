import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

const run = promisify(execFile);

/**
 * Hand a link to macOS rather than following it in the page.
 *
 * A desk row's origin can point outside the app -- a Slack message lives in Slack, not here --
 * and an `<a href>` to one navigates whichever window is showing it. In the desktop shell that is
 * the app's own window, so clicking a Slack row replaced Second Brain with Slack's web client.
 * `open` lets the system route it: `slack://` reaches the installed app, `https://` the browser.
 *
 * Same shape as `activity/open-settings` and `meetings/open-calendar`, which do this for a
 * settings pane and for Calendar.
 */
const ALLOWED = new Set(["http:", "https:", "slack:"]);

export async function POST(req: Request): Promise<Response> {
  if (crossSite(req)) return forbidden();
  try {
    const { url } = (await req.json()) as { url?: unknown };
    if (typeof url !== "string") return Response.json({ error: "url is required" }, { status: 400 });
    // Parsed rather than pattern-matched, and the scheme allow-listed: this runs `open`, which
    // will happily launch a `file://` path or a settings URL if handed one.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Response.json({ error: "not a url" }, { status: 400 });
    }
    if (!ALLOWED.has(parsed.protocol)) return Response.json({ error: `${parsed.protocol} is not openable` }, { status: 400 });
    await run("open", [parsed.toString()]);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
