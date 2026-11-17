import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "@/test/db";

let dir: string;
let r: {
  heartbeat: typeof import("./activity/heartbeat/route");
  calendar: typeof import("./activity/calendar/route");
  day: typeof import("./activity/day/route");
  week: typeof import("./activity/week/route");
  rules: typeof import("./activity/rules/route");
  rule: typeof import("./activity/rules/[id]/route");
  reorder: typeof import("./activity/rules/reorder/route");
  exclusions: typeof import("./activity/exclusions/route");
  pause: typeof import("./activity/pause/route");
  capture: typeof import("./activity/meetings/[id]/capture/route");
  status: typeof import("./activity/status/route");
  openSettings: typeof import("./activity/open-settings/route");
  label: typeof import("./activity/sessions/[id]/label/route");
  identity: typeof import("./settings/identity/route");
};
const TOKEN = "abc123";
const T0 = new Date(2026, 8, 16, 10, 0, 0).getTime(); // local 10:00 so every heartbeat lands on the same local day
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const day = "2026-09-16";

const json = (method: string, url: string, body?: unknown, token?: string) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

beforeAll(async () => {
  // The clock is pinned to the fixtures' own day, not merely the fixtures written down.
  //
  // Every timestamp in this file hangs off T0, and the routes under test read the real clock to
  // decide what is recent -- so as T0 receded the seeded day drifted out of what they would look
  // at, and a rule-ordering assertion started failing for a reason that had nothing to do with
  // rules. Only `Date` is faked: faking timers as well would strand the async route handlers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  dir = makeTempDataDir();
  fs.writeFileSync(path.join(dir, "activity-token"), TOKEN + "\n");
  r = {
    heartbeat: await import("./activity/heartbeat/route"),
    calendar: await import("./activity/calendar/route"),
    day: await import("./activity/day/route"),
    week: await import("./activity/week/route"),
    rules: await import("./activity/rules/route"),
    rule: await import("./activity/rules/[id]/route"),
    reorder: await import("./activity/rules/reorder/route"),
    exclusions: await import("./activity/exclusions/route"),
    pause: await import("./activity/pause/route"),
    capture: await import("./activity/meetings/[id]/capture/route"),
    status: await import("./activity/status/route"),
    openSettings: await import("./activity/open-settings/route"),
    label: await import("./activity/sessions/[id]/label/route"),
    identity: await import("./settings/identity/route"),
  };
});
afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getDay = async () => (await (await r.day.GET(json("GET", `/api/activity/day?date=${day}`))).json()) as Record<string, any>;

describe("activity api", () => {
  it("rejects heartbeats without the token", async () => {
    const res = await r.heartbeat.POST(json("POST", "/api/activity/heartbeat", { at: at(0), appId: "x" }));
    expect(res.status).toBe(401);
    const bad = await r.heartbeat.POST(json("POST", "/api/activity/heartbeat", { at: at(0), appId: "x" }, "nope"));
    expect(bad.status).toBe(401);
  });

  it("ingests heartbeats, returns exclusions, stores helper state", async () => {
    const body = {
      at: at(0), appId: "com.microsoft.VSCode", appName: "Code", title: "a", url: null, idleSeconds: 1,
      helper: { version: "1.0.0", permissions: { accessibility: true, calendar: false, automation: {} } },
    };
    const res = await r.heartbeat.POST(json("POST", "/api/activity/heartbeat", body, TOKEN));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.exclusions.apps).toContain("com.1password.1password");
    expect(data.paused).toBe(false);
    // The Slack reader is told who I am rather than configured with it separately: without this
    // it claims nothing as mine and the questions I asked are never read.
    expect(data.identities).toEqual([]);
    await r.identity.PATCH(json("PATCH", "/api/settings/identity", { names: ["Avinash", "Avinash V"] }, TOKEN));
    const told = await (await r.heartbeat.POST(json("POST", "/api/activity/heartbeat", { ...body, at: at(1) }, TOKEN))).json();
    expect(told.identities).toEqual(["Avinash", "Avinash V"]);
    await r.heartbeat.POST(json("POST", "/api/activity/heartbeat", { ...body, at: at(300) }, TOKEN));
    await r.heartbeat.POST(json("POST", "/api/activity/heartbeat", { at: at(305), appId: "x", appName: "x", title: null, url: null, idleSeconds: 400 }, TOKEN));
    const d = await getDay();
    expect(d.activeMs).toBe(305_000);
    expect(d.helper.permissions.accessibility).toBe(true);
    expect(d.helper.lastSeen).toBe(at(305));
    expect(d.sessions).toHaveLength(2);
    expect(d.retentionDays).toBe(90);
  });

  it("pauses, resumes, and sets retention", async () => {
    let res = await r.pause.POST(json("POST", "/api/activity/pause", { paused: true }));
    expect((await res.json()).paused).toBe(true);
    const hb = await r.heartbeat.POST(json("POST", "/api/activity/heartbeat", { at: at(600), appId: "com.microsoft.VSCode", appName: "Code", title: "b", url: null }, TOKEN));
    expect((await hb.json()).paused).toBe(true);
    expect((await getDay()).sessions).toHaveLength(2);
    res = await r.pause.POST(json("POST", "/api/activity/pause", { paused: false, retentionDays: 30 }));
    expect(await res.json()).toEqual({ paused: false, retentionDays: 30 });
    expect((await getDay()).retentionDays).toBe(30);
  });

  it("drops an excluded heartbeat without writing a session, and rejects a malformed week start", async () => {
    const before = await getDay();
    const res = await r.heartbeat.POST(
      json(
        "POST",
        "/api/activity/heartbeat",
        { at: at(700), appId: "com.google.Chrome", appName: "Chrome", title: "Chase", url: "https://chase.com/login" },
        TOKEN,
      ),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.exclusions.domains).toContain("chase.com");
    const after = await getDay();
    expect(after.sessions.length).toBe(before.sessions.length);
    const badWeek = await r.week.GET(json("GET", "/api/activity/week?start=2026-9-1"));
    expect(badWeek.status).toBe(400);
  });

  it("replaces calendar events and captures a meeting once", async () => {
    const res = await r.calendar.POST(json("POST", "/api/activity/calendar", { events: [{ externalId: "e1", title: "Interview: Jane", startsAt: at(1000), endsAt: at(2800), attendees: 2, hasCallLink: true }] }, TOKEN));
    expect(res.status).toBe(200);
    const d = await getDay();
    expect(d.meetings).toHaveLength(1);
    expect(d.meetings[0].interview).toBe(true);
    const c1 = await r.capture.POST(json("POST", "/x"), params(d.meetings[0].id));
    expect(c1.status).toBe(201);
    const c2 = await r.capture.POST(json("POST", "/x"), params(d.meetings[0].id));
    expect(c2.status).toBe(200);
    expect((await c1.json()).id).toBe((await c2.json()).id);
  });

  it("takes the richer calendar fields and the calendars-seen signal", async () => {
    const before = (await (await r.status.GET()).json()) as { helper: { calendarsSeen: number | null } };
    expect(before.helper.calendarsSeen).toBeNull();
    const res = await r.calendar.POST(
      json(
        "POST",
        "/api/activity/calendar",
        {
          events: [
            {
              externalId: "e1",
              title: "Interview: Jane",
              startsAt: at(1000),
              endsAt: at(2800),
              attendees: 2,
              hasCallLink: false,
              organizer: "Ada",
              attendeeNames: ["Ada", "Jane"],
              location: "Room 4",
              notes: "Join https://zoom.us/j/9",
              status: "accepted",
              calendarTitle: "Work",
            },
          ],
          calendarsSeen: 3,
        },
        TOKEN,
      ),
    );
    expect(res.status).toBe(200);
    const m = (await getDay()).meetings[0];
    expect(m).toMatchObject({ organizer: "Ada", attendeeNames: ["Ada", "Jane"], joinUrl: "https://zoom.us/j/9", status: "accepted", calendarTitle: "Work", allDay: false, noRecord: false, hasCallLink: true });
    expect(m.itemId).not.toBeNull(); // the capture from the previous test survived the day replace
    const after = (await (await r.status.GET()).json()) as { helper: { calendarsSeen: number | null } };
    expect(after.helper.calendarsSeen).toBe(3);
  });

  it("trims oversized notes and attendee lists instead of rejecting the payload", async () => {
    // 3999 chars + one astral emoji = 4001 UTF-16 units but 4000 graphemes: the helper's own cap can overshoot zod's.
    const notes = "x".repeat(3999) + "\u{1F600}";
    expect(notes.length).toBe(4001);
    const res = await r.calendar.POST(
      json(
        "POST",
        "/api/activity/calendar",
        {
          events: [
            {
              externalId: "e1",
              title: "Interview: Jane",
              startsAt: at(1000),
              endsAt: at(2800),
              attendees: 12,
              hasCallLink: false,
              attendeeNames: Array.from({ length: 12 }, (_, i) => `Guest ${i}`),
              joinUrl: "not a url",
              notes,
            },
          ],
        },
        TOKEN,
      ),
    );
    expect(res.status).toBe(200);
    const m = (await getDay()).meetings[0];
    expect(m.attendeeNames).toHaveLength(10);
    expect(m.joinUrl).toBeNull();
    const { getDb } = await import("@/db/client");
    const { calendarEvents } = await import("@/db/schema");
    const row = getDb().select().from(calendarEvents).all()[0];
    expect(row.notes.length).toBe(4000);
  });

  it("keeps the window when an unauthorised helper posts an empty payload", async () => {
    const before = (await getDay()).meetings.length;
    expect(before).toBeGreaterThan(0);
    const res = await r.calendar.POST(
      json("POST", "/api/activity/calendar", { events: [], window: { from: "2026-09-01", to: "2026-10-01" } }, TOKEN),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: 0 });
    expect((await getDay()).meetings).toHaveLength(before);
  });

  it("refuses to open System Settings for a page on another site", async () => {
    // No `open` runs, so the assertion is the status alone: a same-origin call would launch it.
    const req = new Request("http://127.0.0.1:3141/api/activity/open-settings", { method: "POST", headers: { origin: "https://evil.example" } });
    const res = await r.openSettings.POST(req);
    expect(res.status).toBe(403);
  });

  it("manages rules, reorders, and recategorises", async () => {
    const list = (await (await r.rules.GET()).json()) as { id: number }[];
    const cats = (await getDay()).categories as { id: number; name: string }[];
    const writing = cats.find((c) => c.name === "Writing")!.id;
    const created = await r.rules.POST(json("POST", "/api/activity/rules", { matchKind: "app", pattern: "com.microsoft.VSCode", categoryId: writing }));
    expect(created.status).toBe(201);
    const rule = (await created.json()) as { id: number };
    await r.reorder.POST(json("POST", "/api/activity/rules/reorder", { ids: [rule.id, ...list.map((x) => x.id)] }));
    const d = await getDay();
    expect(d.byCategory[0].categoryId).toBe(writing);
    const bad = await r.rules.POST(json("POST", "/api/activity/rules", { matchKind: "nope", pattern: "x", categoryId: writing }));
    expect(bad.status).toBe(400);
    const del = await r.rule.DELETE(json("DELETE", "/x"), params(rule.id));
    expect(del.status).toBe(204);
  });

  it("adds and rejects duplicate exclusions", async () => {
    const ok = await r.exclusions.POST(json("POST", "/api/activity/exclusions", { kind: "domain", pattern: "secret.example" }));
    expect(ok.status).toBe(201);
    const dup = await r.exclusions.POST(json("POST", "/api/activity/exclusions", { kind: "domain", pattern: "secret.example" }));
    expect(dup.status).toBe(409);
  });

  it("labels a session and serves a week", async () => {
    const d = await getDay();
    const leisure = (d.categories as { id: number; name: string }[]).find((c) => c.name === "Leisure")!.id;
    const res = await r.label.POST(json("POST", "/x", { categoryId: leisure }), params(d.sessions[0].id));
    expect(res.status).toBe(200);
    const w = (await (await r.week.GET(json("GET", `/api/activity/week?start=${day}`))).json()) as { days: { day: string }[] };
    expect(w.days).toHaveLength(7);
    const badDay = await r.day.GET(json("GET", "/api/activity/day?date=2026-9-1"));
    expect(badDay.status).toBe(400);
  });
});
