import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { makeTempDataDir } from "@/test/db";

let dir: string;
let r: { focus: typeof import("./settings/focus/route") };
const json = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

/** The same request as `json`, but from a page on another origin — what `crossSite` gates on. */
const foreign = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { origin: "https://evil.example", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  dir = makeTempDataDir();
  r = { focus: await import("./settings/focus/route") };
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("focus settings api", () => {
  it("defaults to 25/5/15/4 on the pomodoro, accepts a partial patch, and rejects a bad body", async () => {
    expect(await (await r.focus.GET()).json()).toEqual({ defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" });

    const ok = await r.focus.PATCH(json("PATCH", "/api/settings/focus", { defaultMinutes: 50 }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ defaultMinutes: 50, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" });

    const both = await r.focus.PATCH(json("PATCH", "/api/settings/focus", { shortBreak: 10, longBreakEvery: 3 }));
    expect(await both.json()).toEqual({ defaultMinutes: 50, shortBreak: 10, longBreak: 15, longBreakEvery: 3, mode: "pomodoro" });

    expect((await r.focus.PATCH(json("PATCH", "/api/settings/focus", { defaultMinutes: 4 }))).status).toBe(400);
    expect((await r.focus.PATCH(json("PATCH", "/api/settings/focus", { defaultMinutes: 481 }))).status).toBe(400);
    expect((await r.focus.PATCH(json("PATCH", "/api/settings/focus", { longBreakEvery: 1 }))).status).toBe(400);
    expect((await r.focus.PATCH(json("PATCH", "/api/settings/focus", { nope: 1 }))).status).toBe(400);
    expect((await r.focus.PATCH(new Request("http://localhost/api/settings/focus", { method: "PATCH" }))).status).toBe(400);

    // The bad patches above never landed.
    expect(await (await r.focus.GET()).json()).toEqual({ defaultMinutes: 50, shortBreak: 10, longBreak: 15, longBreakEvery: 3, mode: "pomodoro" });
  });

  it("switches the rhythm, and refuses one that is not a rhythm", async () => {
    expect((await r.focus.PATCH(json("PATCH", "/api/settings/focus", { mode: "timebox" }))).status).toBe(200);
    expect((await (await r.focus.GET()).json()).mode).toBe("timebox");
    expect((await r.focus.PATCH(json("PATCH", "/api/settings/focus", { mode: "sprint" }))).status).toBe(400);
    // The bad patch never landed.
    expect((await (await r.focus.GET()).json()).mode).toBe("timebox");
  });

  it("gates PATCH on the same-origin guard — unlike the older settings routes it is modelled on", async () => {
    const res = await r.focus.PATCH(foreign("PATCH", "/api/settings/focus", { defaultMinutes: 30 }));
    expect(res.status).toBe(403);
  });
});
