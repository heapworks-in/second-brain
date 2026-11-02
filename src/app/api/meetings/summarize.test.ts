import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { makeTempDataDir } from "@/test/db";

let dir: string;
let route: typeof import("./[id]/summarize/route");

const post = (id: number) => new Request(`http://localhost/api/meetings/${id}/summarize`, { method: "POST" });
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

beforeAll(async () => {
  dir = makeTempDataDir();
  route = await import("./[id]/summarize/route");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("meeting summarize api", () => {
  it("queues a pass for a transcribed meeting, and says why when there is nothing to summarise", async () => {
    const { getDb } = await import("@/db/client");
    const { createItem, updateItem } = await import("@/domain/items");
    const { listJobs } = await import("@/jobs/queue");
    const db = getDb();

    const meeting = createItem(db, { type: "meeting", title: "Sync" });
    // Nothing on it yet: the button is not offered in this state, and the route says so anyway.
    expect((await route.POST(post(meeting.id), params(meeting.id))).status).toBe(400);
    expect(listJobs(db, { itemId: meeting.id })).toHaveLength(0);

    updateItem(db, meeting.id, { extractedText: "we chose Tuesday" });
    const res = await route.POST(post(meeting.id), params(meeting.id));
    expect(res.status).toBe(200);
    expect(listJobs(db, { itemId: meeting.id }).map((j) => j.type)).toEqual(["summarize_meeting"]);

    expect((await route.POST(post(9999), params(9999))).status).toBe(404);
  });
});
