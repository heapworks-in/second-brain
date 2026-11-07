import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { makeTempDataDir } from "@/test/db";

/**
 * The day most of these cases put their sessions on. Derived, not written down: a task carries
 * its sessions only within a window around today, so a fixed date silently falls out of that
 * window as it recedes and the list simply stops returning them. It was a fixed date and did
 * exactly that, eight days after it was written -- the same expiry as PLACE_DAY below, which was
 * fixed first on the mistaken reasoning that a date already in the past could not newly break.
 *
 * Today needs no weekday check: these cases place sessions at explicit times rather than asking
 * placement to find slots, so working days do not come into it.
 */
const DAY = shift(0);

let dir: string;
let r: {
  blocks: typeof import("./blocks/route");
  block: typeof import("./blocks/[id]/route");
  taskBlocks: typeof import("./tasks/[id]/blocks/route");
  place: typeof import("./plan/place/route");
  tasks: typeof import("./tasks/route");
  plan: typeof import("./plan/route");
};
const json = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

/** A day inside the list's window that is never DAY, however the calendar happens to fall. */
function otherDay(): string {
  for (let n = 3; n < 10; n += 1) {
    const day = shift(n);
    if (day !== DAY) return day;
  }
  throw new Error("no day inside the window that is not DAY");
}

/**
 * The placement's own day: far enough ahead that nothing an earlier case left behind can sit in
 * its slots, and a weekday, since those are the working days placement fills.
 *
 * Derived rather than written down. This was a fixed date a week in the future when it was
 * written, and it became *today* -- which left half its working hours in the past and one of the
 * two sessions with nowhere to go. That is the third hardcoded future date in this suite to
 * expire, so this one cannot: it is always a week or so ahead of whenever the suite runs.
 */
function placeDay(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const PLACE_DAY = placeDay();

function shift(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface BlockBody {
  id: number;
  taskId: number;
  startsAt: string;
  minutes: number;
}

async function addTask(title: string, over: Record<string, unknown> = {}): Promise<number> {
  return ((await (await r.tasks.POST(json("POST", "/api/tasks", { title, ...over }))).json()) as { id: number }).id;
}

async function addBlock(taskId: number, startsAt: string, minutes: number): Promise<BlockBody> {
  const res = await r.blocks.POST(json("POST", "/api/blocks", { taskId, startsAt, minutes }));
  expect(res.status).toBe(201);
  return (await res.json()) as BlockBody;
}

beforeAll(async () => {
  dir = makeTempDataDir();
  r = {
    blocks: await import("./blocks/route"),
    block: await import("./blocks/[id]/route"),
    taskBlocks: await import("./tasks/[id]/blocks/route"),
    place: await import("./plan/place/route"),
    tasks: await import("./tasks/route"),
    plan: await import("./plan/route"),
  };
  // A meeting for the placement to work around, written through the calendar the app uses.
  const { getDb } = await import("@/db/client");
  const { replaceCalendarEvents } = await import("@/domain/activity");
  replaceCalendarEvents(getDb(), [
    { externalId: "m1", title: "Sync", startsAt: `${DAY}T10:00:00`, endsAt: `${DAY}T11:00:00`, attendees: 2, hasCallLink: true },
    { externalId: "m2", title: "Sync", startsAt: `${PLACE_DAY}T10:00:00`, endsAt: `${PLACE_DAY}T11:00:00`, attendees: 2, hasCallLink: true },
  ]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("blocks api", () => {
  it("puts another box in the first free time on the day, and refuses a body that is neither shape", async () => {
    // A day of its own, well clear of the placement cases below: this suite shares one database,
    // so a box left on PLACE_DAY would change what "fills the day" there has room for.
    const boxDay = shift(20);
    const taskId = await addTask("Migrate the store");
    const first = await r.blocks.POST(json("POST", "/api/blocks", { taskId, minutes: 45, date: boxDay, at: "next-free" }));
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ taskId, startsAt: `${boxDay}T09:00:00`, minutes: 45, spentMinutes: 0 });

    // The next one takes the first free time left, which is the end of the one already there.
    const second = await r.blocks.POST(json("POST", "/api/blocks", { taskId, minutes: 45, date: boxDay, at: "next-free" }));
    expect(await second.json()).toMatchObject({ startsAt: `${boxDay}T09:45:00`, minutes: 45 });

    // Neither a slot nor a day: a start and `at` together name two different things.
    expect((await r.blocks.POST(json("POST", "/api/blocks", { taskId, minutes: 45, at: "next-free" }))).status).toBe(400);
    expect((await r.blocks.POST(json("POST", "/api/blocks", { taskId, minutes: 45, date: boxDay, at: "whenever" }))).status).toBe(400);
    expect((await r.blocks.POST(json("POST", "/api/blocks", { taskId, minutes: 45, date: boxDay, startsAt: `${boxDay}T09:00:00`, at: "next-free" }))).status).toBe(400);
  });

  it("creates, moves, resizes and removes a session", async () => {
    const taskId = await addTask("Write the launch note", { estimateMinutes: 60 });
    const block = await addBlock(taskId, `${DAY}T09:00:00`, 45);
    expect(block).toEqual({ id: block.id, taskId, startsAt: `${DAY}T09:00:00`, minutes: 45, spentMinutes: 0 });

    const moved = await r.block.PATCH(json("PATCH", "/x", { startsAt: `${DAY}T11:30:00`, minutes: 30 }), params(block.id));
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ id: block.id, taskId, startsAt: `${DAY}T11:30:00`, minutes: 30, spentMinutes: 0 });

    // The task carries its sessions wherever it is listed.
    const listed = (await (await r.tasks.GET(json("GET", "/api/tasks?status=open"))).json()) as { tasks: { id: number; blocks: BlockBody[] }[] };
    expect(listed.tasks.find((t) => t.id === taskId)!.blocks).toEqual([{ id: block.id, taskId, startsAt: `${DAY}T11:30:00`, minutes: 30, spentMinutes: 0 }]);

    expect((await r.block.DELETE(json("DELETE", "/x"), params(block.id))).status).toBe(204);
    expect((await r.block.DELETE(json("DELETE", "/x"), params(block.id))).status).toBe(404);
  });

  it("clears one day's sessions and leaves another day's alone", async () => {
    const taskId = await addTask("Draft the brief");
    await addBlock(taskId, `${DAY}T09:00:00`, 30);
    await addBlock(taskId, `${DAY}T14:00:00`, 30);
    // Inside the window a task list carries, whenever this runs -- and provably not DAY itself.
    // `shift` counts from today while DAY is fixed, so the two collided exactly once the calendar
    // reached three days before DAY, and the "other day" block landed on the day being cleared.
    const other = await addBlock(taskId, `${otherDay()}T09:00:00`, 30);
    const cleared = await r.taskBlocks.DELETE(json("DELETE", `/api/tasks/${taskId}/blocks?date=${DAY}`), params(taskId));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ removed: 2 });
    const after = (await (await r.tasks.GET(json("GET", "/api/tasks?status=open"))).json()) as { tasks: { id: number; blocks: BlockBody[] }[] };
    expect(after.tasks.find((t) => t.id === taskId)!.blocks.map((b) => b.id)).toEqual([other.id]);
  });

  // Its own day and its own tasks: what the cases above placed or cleared cannot move these.
  it("places one task's sessions around the day's meeting, and fills the day", async () => {
    const taskId = await addTask("Long piece of work", { estimateMinutes: 120 });
    const placed = await r.place.POST(json("POST", "/api/plan/place", { date: PLACE_DAY, taskId }));
    expect(placed.status).toBe(200);
    // 09:00–09:45; the ten-minute break would leave only five minutes of the morning slot, so
    // the second session waits for the meeting to end (11:00–11:45) and the third takes its
    // break after it (11:55–12:25).
    expect(await placed.json()).toEqual({ placed: 3, unplacedMinutes: 0 });

    const waiting = await addTask("Waiting on the plan", { estimateMinutes: 45, sessionMinutes: 45 });
    await r.plan.POST(json("POST", "/api/plan", { date: PLACE_DAY, taskId: waiting }));
    const filled = await r.place.POST(json("POST", "/api/plan/place", { date: PLACE_DAY }));
    // 09:45–10:00 is all that is left before the meeting: the session takes it and carries the
    // rest past the morning's work, to 12:25.
    expect(await filled.json()).toEqual({ placed: 2, unplacedMinutes: 0 });
    const day = (await (await r.plan.GET(json("GET", `/api/plan?date=${PLACE_DAY}`))).json()) as { tasks: { id: number; blocks: BlockBody[]; sessionMinutes: number | null }[] };
    const row = day.tasks.find((t) => t.id === waiting)!;
    expect(row.sessionMinutes).toBe(45);
    expect(row.blocks.map((b) => [b.startsAt.slice(11, 16), b.minutes])).toEqual([["09:45", 15], ["12:25", 30]]);
  });

  it("carries the sessions near today and leaves an old one out of the payload", async () => {
    const taskId = await addTask("Long runner");
    // A month back is outside the window a list carries; three days ahead is inside it.
    await addBlock(taskId, `${shift(-30)}T09:00:00`, 30);
    const soon = await addBlock(taskId, `${shift(3)}T09:00:00`, 30);
    const listed = (await (await r.tasks.GET(json("GET", "/api/tasks?status=open"))).json()) as { tasks: { id: number; blocks: BlockBody[] }[] };
    expect(listed.tasks.find((t) => t.id === taskId)!.blocks.map((b) => b.id)).toEqual([soon.id]);
  });

  it("refuses a body it cannot read", async () => {
    const taskId = await addTask("Checks");
    expect((await r.blocks.POST(json("POST", "/api/blocks", { taskId, startsAt: `${DAY} 09:00`, minutes: 30 }))).status).toBe(400);
    expect((await r.blocks.POST(json("POST", "/api/blocks", { taskId, startsAt: `${DAY}T09:00:00`, minutes: 3 }))).status).toBe(400);
    expect((await r.blocks.POST(json("POST", "/api/blocks", { taskId, startsAt: `${DAY}T09:00:00`, minutes: 30, nope: 1 }))).status).toBe(400);
    expect((await r.blocks.POST(json("POST", "/api/blocks", { taskId: 9999, startsAt: `${DAY}T09:00:00`, minutes: 30 }))).status).toBe(404);
    expect((await r.block.PATCH(json("PATCH", "/x", { taskId: 2 }), params(1))).status).toBe(400);
    expect((await r.block.PATCH(json("PATCH", "/x", { minutes: 30 }), params(9999))).status).toBe(404);
    expect((await r.taskBlocks.DELETE(json("DELETE", `/api/tasks/${taskId}/blocks?date=nope`), params(taskId))).status).toBe(400);
    expect((await r.taskBlocks.DELETE(json("DELETE", `/api/tasks/${taskId}/blocks`), params(taskId))).status).toBe(400);
    expect((await r.place.POST(json("POST", "/api/plan/place", { date: "nope" }))).status).toBe(400);
    expect((await r.place.POST(json("POST", "/api/plan/place", { date: DAY, taskId: 9999 }))).status).toBe(404);
  });
});
