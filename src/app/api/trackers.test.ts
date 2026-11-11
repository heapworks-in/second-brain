import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import { makeTempDataDir } from "@/test/db";
import { getDb } from "@/db/client";
import { people, tasks, trackers } from "@/db/schema";
import { listTasks } from "@/domain/tasks";
import { writeWorkbook } from "@/domain/trackers/sheet";
import { identityNames } from "@/domain/trackers/identity";

let dir: string;
let r: {
  parse: typeof import("./trackers/parse/route");
  trackers: typeof import("./trackers/route");
  one: typeof import("./trackers/[id]/route");
  exportRoute: typeof import("./trackers/[id]/export/route");
};

const HEADERS = ["Theme", "Task", "Sub task", "Owner", "ETA", "Team", "Comments", "Status", "Risk"];
const ROWS = [
  { Theme: "Migration", Task: "Move the database", "Sub task": "Take a backup", Owner: "Priya Raman", ETA: "12/11/2026", Team: "Platform", Comments: "Overnight", Status: "In Progress", Risk: "High" },
  { Theme: "Migration", Task: "Move the database", "Sub task": "Cut over", Owner: "Avinash", ETA: "mid Nov", Team: "", Comments: "", Status: "Blocked", Risk: "" },
];

const json = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });

async function upload(name: string, headers = HEADERS, rows = ROWS): Promise<Request> {
  const buffer = await writeWorkbook({ name: "Plan", headers, rows });
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buffer)], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  return new Request("http://localhost/api/trackers/parse", { method: "POST", body: form });
}

beforeAll(async () => {
  dir = makeTempDataDir();
  r = {
    parse: await import("./trackers/parse/route"),
    trackers: await import("./trackers/route"),
    one: await import("./trackers/[id]/route"),
    exportRoute: await import("./trackers/[id]/export/route"),
  };
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  const db = getDb();
  db.delete(tasks).run();
  db.delete(trackers).run();
  db.delete(people).run();
});

describe("POST /api/trackers/parse", () => {
  it("reads a real file and says what importing it would do, writing nothing", async () => {
    const res = await r.parse.POST(await upload("q4.xlsx"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sheets[0].headers).toEqual(HEADERS);
    expect(body.mapping.columns).toMatchObject({ theme: "Theme", task: "Task", subTask: "Sub task", owner: "Owner", eta: "ETA", status: "Status" });
    expect(body.plan.counts).toEqual({ create: 2, update: 0, skip: 0 });
    expect(body.plan.unknownStatuses).toEqual(["In Progress", "Blocked"]);
    expect(body.plan.unparsedEtas).toEqual([{ row: 2, text: "mid Nov" }]);
    expect(getDb().select().from(trackers).all()).toHaveLength(0);
  });

  it("says what to do about a file it cannot read, rather than failing blankly", async () => {
    const form = new FormData();
    form.set("file", new File(["a,b\n1,2"], "plan.csv", { type: "text/csv" }));
    const res = await r.parse.POST(new Request("http://localhost/api/trackers/parse", { method: "POST", body: form }));
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/Save As/);
  });

  it("refuses a file with no header row and any rows under it", async () => {
    const res = await r.parse.POST(await upload("empty.xlsx", ["Only one column"], []));
    expect(res.status).toBe(422);
  });
});

describe("POST /api/trackers", () => {
  const body = (over: Record<string, unknown> = {}) => ({
    name: "Q4 Migration",
    headers: HEADERS,
    rows: ROWS,
    mapping: { columns: { theme: "Theme", task: "Task", subTask: "Sub task", owner: "Owner", eta: "ETA", team: "Team", comments: "Comments", status: "Status" }, theme: "group" },
    statusMap: {},
    identityNames: ["Avinash"],
    sourceName: "q4.xlsx",
    sheetName: "Plan",
    ...over,
  });

  it("imports, remembers who I am, and keeps the team's rows out of my lists", async () => {
    const res = await r.trackers.POST(json("POST", "/api/trackers", body()));
    expect(res.status).toBe(201);
    const out = await res.json();
    expect([out.created, out.updated]).toEqual([2, 0]);
    expect(out.peopleCreated).toEqual(["Priya Raman"]);
    expect(identityNames(getDb())).toEqual(["Avinash"]);
    expect(listTasks(getDb(), { status: "all" }).map((t) => t.title)).toEqual(["Cut over"]);
  });

  it("answers a dry run with the same plan and no rows", async () => {
    const res = await r.trackers.POST(json("POST", "/api/trackers", body({ dryRun: true })));
    expect((await res.json()).plan.counts).toEqual({ create: 2, update: 0, skip: 0 });
    expect(listTasks(getDb(), { status: "all", owner: "anyone" })).toHaveLength(0);
  });

  it("refuses a body that names a column that is not a field", async () => {
    const res = await r.trackers.POST(json("POST", "/api/trackers", body({ mapping: { columns: { nonsense: "Theme" }, theme: "group" } })));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/trackers/[id]/export", () => {
  it("answers with a real xlsx file, named after the tracker and dated", async () => {
    const made = await (await r.trackers.POST(json("POST", "/api/trackers", {
      name: "Q4 Migration",
      headers: HEADERS,
      rows: ROWS,
      mapping: { columns: { theme: "Theme", task: "Task", subTask: "Sub task", owner: "Owner", eta: "ETA", team: "Team", comments: "Comments", status: "Status" }, theme: "group" },
      statusMap: {},
      identityNames: ["Avinash"],
    }))).json();

    const res = await r.exportRoute.GET(json("GET", "/x"), { params: Promise.resolve({ id: String(made.tracker.id) }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/spreadsheetml/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="q4-migration-\d{4}-\d{2}-\d{2}\.xlsx"/);
    // A zip, which is what an xlsx is: the first two bytes say so.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  it("is a 404 for a tracker that is not there", async () => {
    const res = await r.exportRoute.GET(json("GET", "/x"), { params: Promise.resolve({ id: "404" }) });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/trackers/[id]", () => {
  async function imported() {
    const res = await r.trackers.POST(json("POST", "/api/trackers", {
      name: "Q4 Migration",
      headers: HEADERS,
      rows: ROWS,
      mapping: { columns: { theme: "Theme", task: "Task", subTask: "Sub task", owner: "Owner", eta: "ETA", team: "Team", comments: "Comments", status: "Status" }, theme: "group" },
      statusMap: {},
      identityNames: ["Avinash"],
    }));
    return (await res.json()).tracker.id as number;
  }

  it("keeps the rows by default and deletes them only when asked", async () => {
    const id = await imported();
    const keep = await r.one.DELETE(json("DELETE", `/api/trackers/${id}`), { params: Promise.resolve({ id: String(id) }) });
    expect((await keep.json()).deletedRows).toBe(0);
    expect(listTasks(getDb(), { status: "all", owner: "anyone" })).toHaveLength(2);

    const second = await imported();
    const gone = await r.one.DELETE(json("DELETE", `/api/trackers/${second}?rows=delete`), { params: Promise.resolve({ id: String(second) }) });
    expect((await gone.json()).deletedRows).toBe(2);
  });
});
