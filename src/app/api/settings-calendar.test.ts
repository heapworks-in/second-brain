import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "@/test/db";

let dir: string;
let r: { calendar: typeof import("./settings/calendar/route"); sync: typeof import("./settings/calendar/sync/route") };
const ICS = fs.readFileSync(path.join(process.cwd(), "src/test/fixtures/outlook-feed.ics"), "utf8");
const json = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

beforeAll(async () => {
  dir = makeTempDataDir();
  r = { calendar: await import("./settings/calendar/route"), sync: await import("./settings/calendar/sync/route") };
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

describe("calendar feed api", () => {
  it("starts empty, rejects a bad link, and syncs a good one on save and on demand", async () => {
    expect(await (await r.calendar.GET()).json()).toMatchObject({ feedUrl: "", syncedAt: null, error: null, count: 0 });
    expect((await r.calendar.PATCH(json("PATCH", "/api/settings/calendar", { feedUrl: "ftp://x/y.ics" }))).status).toBe(400);
    expect((await r.calendar.PATCH(json("PATCH", "/api/settings/calendar", { nope: 1 }))).status).toBe(400);

    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        return new Response(ICS, { status: 200 });
      }),
    );
    const saved = await r.calendar.PATCH(json("PATCH", "/api/settings/calendar", { feedUrl: "webcal://example.com/cal.ics" }));
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { feedUrl: string; count: number; sync: { state: string } };
    expect(body.feedUrl).toBe("https://example.com/cal.ics");
    expect(body.count).toBe(11);
    expect(body.sync.state).toBe("ok");
    expect(fetched).toEqual(["https://example.com/cal.ics"]);

    const again = (await (await r.sync.POST(json("POST", "/api/settings/calendar/sync"))).json()) as { sync: { state: string } };
    expect(again.sync.state).toBe("ok");
    expect(fetched).toHaveLength(2);

    const foreign = new Request("http://localhost/api/settings/calendar/sync", { method: "POST", headers: { origin: "https://evil.example" } });
    expect((await r.sync.POST(foreign)).status).toBe(403);
    const foreignPatch = new Request("http://localhost/api/settings/calendar", { method: "PATCH", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ feedUrl: "" }) });
    expect((await r.calendar.PATCH(foreignPatch)).status).toBe(403);

    const cleared = (await (await r.calendar.PATCH(json("PATCH", "/api/settings/calendar", { feedUrl: "" }))).json()) as { feedUrl: string; sync: { state: string } };
    expect(cleared).toMatchObject({ feedUrl: "", sync: { state: "off" } });
  });
});
