import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { makeTempDataDir } from "@/test/db";
import { todayLocal } from "@/components/activity/format";
import type { HomeDTO } from "@/lib/dto";

let dir: string;
let r: { home: typeof import("./home/route"); tasks: typeof import("./tasks/route"); plan: typeof import("./plan/route") };

const json = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

beforeAll(async () => {
  dir = makeTempDataDir();
  r = { home: await import("./home/route"), tasks: await import("./tasks/route"), plan: await import("./plan/route") };
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("home api", () => {
  it("answers with the whole day in one payload", async () => {
    const res = await r.home.GET();
    expect(res.status).toBe(200);
    const home = (await res.json()) as HomeDTO;
    expect(home.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(home.today).toBe(todayLocal());
    expect(home.day.date).toBe(home.date);
    expect(home.counts).toEqual({ planned: 0, meetings: 0, inbox: 0, desk: 0 });
    expect(home.now).toBeNull();
    expect(home).toMatchObject({ next: [], projects: [], recent: [], activity: null });
    // The Planner's day arrives whole, picker and capacity included.
    expect(home.day.capacity.workHours).toBeTruthy();
    expect(home.day.sources).toMatchObject({ inbox: [], projects: [], areas: [] });
  });

  it("counts a task planned for today", async () => {
    const created = await r.tasks.POST(json("POST", "/api/tasks", { title: "Draft the brief" }));
    const { id } = (await created.json()) as { id: number };
    const today = ((await (await r.home.GET()).json()) as HomeDTO).date;
    expect((await r.plan.POST(json("POST", "/api/plan", { date: today, taskId: id }))).status).toBe(201);

    const home = (await (await r.home.GET()).json()) as HomeDTO;
    expect(home.counts.planned).toBe(1);
    expect(home.day.plan.map((t) => t.title)).toEqual(["Draft the brief"]);
  });
});
