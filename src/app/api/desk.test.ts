import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { makeTempDataDir } from "@/test/db";
import { getDb } from "@/db/client";
import { calendarEvents, containers, items, proposals, tasks } from "@/db/schema";
import { reconcileProposals } from "@/domain/desk";
import { resetUndos } from "@/domain/desk/decide";
import type { ProposalDraft } from "@/domain/desk/types";

let dir: string;
let r: {
  desk: typeof import("./desk/route");
  one: typeof import("./desk/[id]/route");
  refresh: typeof import("./desk/refresh/route");
};

const NOW = new Date("2026-11-08T09:00:00.000Z");

const json = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  dir = makeTempDataDir();
  r = {
    desk: await import("./desk/route"),
    one: await import("./desk/[id]/route"),
    refresh: await import("./desk/refresh/route"),
  };
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  resetUndos();
  const db = getDb();
  db.delete(proposals).run();
  db.delete(tasks).run();
  db.delete(items).run();
  db.delete(containers).run();
  db.delete(calendarEvents).run();
});

function file(draft: Partial<ProposalDraft> & Pick<ProposalDraft, "kind" | "payload">) {
  reconcileProposals(
    getDb(),
    [{ source: "task", sourceRef: `${draft.kind}:1`, title: "A card", detail: "The evidence", urgency: 0.5, ...draft } as ProposalDraft],
    NOW,
  );
  return getDb().select().from(proposals).where(eq(proposals.kind, draft.kind)).get()!;
}

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe("GET /api/desk", () => {
  it("is empty and says so rather than failing on a fresh database", async () => {
    expect(await (await r.desk.GET()).json()).toEqual({ proposals: [], open: 0, decidedToday: 0 });
  });

  it("carries the card, and the dismiss rate behind its ranking, but never the payload", async () => {
    const p = file({ kind: "capture_unfiled", payload: { itemId: 1, containerId: 2, containerName: "Migrations" } });
    const body = await (await r.desk.GET()).json();
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ id: p.id, kind: "capture_unfiled", title: "A card", detail: "The evidence", dismissRate: 0 });
    expect(body.proposals[0]).not.toHaveProperty("payload");
  });

  /** Everything open comes back. The desk used to return seven of however many and show one at a
   *  time; in 810 sweeps nothing was ever decided, because a page that hides most of itself gives
   *  you no reason to open it. */
  it("returns every open decision, best first", async () => {
    const kinds = ["capture_unfiled", "task_stalled", "task_overrun", "decision_stale", "prediction_due", "commitment_owed"] as const;
    const drafts: ProposalDraft[] = Array.from({ length: 11 }, (_, i) => ({
      kind: kinds[i % kinds.length],
      source: "item",
      sourceRef: `item:${i}`,
      title: `Card ${i}`,
      detail: "",
      payload: {},
      urgency: (11 - i) / 11,
    }));
    reconcileProposals(getDb(), drafts, NOW);
    const body = await (await r.desk.GET()).json();
    expect(body.proposals).toHaveLength(11);
    expect(body.open).toBe(11);
    const ranks = body.proposals.map((p: { rank: number }) => p.rank);
    expect([...ranks].sort((a: number, b: number) => b - a)).toEqual(ranks);
  });

  it("does not hide a kind behind a noisier one", async () => {
    // Eight overdue rows once took all seven slots while two other kinds sat open and invisible.
    const drafts: ProposalDraft[] = [
      ...Array.from({ length: 8 }, (_, i) => ({
        kind: "capture_unfiled" as const,
        source: "item" as const,
        sourceRef: `item:${i}`,
        title: `Noise ${i}`,
        detail: "",
        payload: {},
        urgency: 1,
      })),
      { kind: "task_stalled" as const, source: "task" as const, sourceRef: "task:1", title: "Quiet one", detail: "", payload: {}, urgency: 0.05 },
    ];
    reconcileProposals(getDb(), drafts, NOW);
    const body = await (await r.desk.GET()).json();
    expect(body.proposals.map((p: { title: string }) => p.title)).toContain("Quiet one");
  });

  it("carries what each card is about, so a row can be checked rather than trusted", async () => {
    const container = getDb()
      .insert(containers)
      .values({ kind: "project", name: "Atlas", slug: "atlas", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      .returning()
      .get();
    const task = getDb()
      .insert(tasks)
      .values({ title: "Late thing", dueDate: "2026-11-01", containerId: container.id, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
      .returning()
      .get();
    reconcileProposals(
      getDb(),
      [{ kind: "task_overdue" as const, source: "task" as const, sourceRef: `task:${task.id}`, title: "Late thing", detail: "", payload: { taskId: task.id }, urgency: 0.5 }],
      NOW,
    );
    const body = await (await r.desk.GET()).json();
    expect(body.proposals[0].origin).toEqual({ label: "Atlas", href: "/c/atlas" });
  });
});

describe("POST /api/desk/[id]", () => {
  it("answers with what happened and the desk as it now stands", async () => {
    const task = getDb().insert(tasks).values({ title: "Write the migration", estimateMinutes: 60, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
    const p = file({ kind: "task_overrun", payload: { taskId: task.id, proposedMinutes: 90 } });

    const body = await (await r.one.POST(json("POST", `/api/desk/${p.id}`, { decision: "accept" }), ctx(p.id))).json();
    expect(body.label).toBe("Re-estimated to 1h 30m");
    expect(body.undoable).toBe(true);
    expect(body.desk).toMatchObject({ proposals: [], open: 0, decidedToday: 1 });
  });

  it("marks a snooze and a dismissal as nothing to take back", async () => {
    const snoozed = file({ kind: "capture_unfiled", payload: {} });
    const snooze = await (await r.one.POST(json("POST", `/api/desk/${snoozed.id}`, { decision: "snooze" }), ctx(snoozed.id))).json();
    expect(snooze).toMatchObject({ label: "Back in 7 days", undoable: false });

    const dismissed = file({ kind: "task_stalled", payload: {} });
    const dismiss = await (await r.one.POST(json("POST", `/api/desk/${dismissed.id}`, { decision: "dismiss" }), ctx(dismissed.id))).json();
    expect(dismiss).toMatchObject({ label: "Won't ask again", undoable: false });
  });

  it("refuses a decision it does not know, and a second answer to the same card", async () => {
    const p = file({ kind: "capture_unfiled", payload: {} });
    expect((await r.one.POST(json("POST", `/api/desk/${p.id}`, { decision: "maybe" }), ctx(p.id))).status).toBe(400);
    await r.one.POST(json("POST", `/api/desk/${p.id}`, { decision: "dismiss" }), ctx(p.id));
    expect((await r.one.POST(json("POST", `/api/desk/${p.id}`, { decision: "accept" }), ctx(p.id))).status).toBe(409);
  });

  it("is 404 for a card that does not exist", async () => {
    expect((await r.one.POST(json("POST", "/api/desk/9999", { decision: "accept" }), ctx(9999))).status).toBe(404);
  });

  /** A card commits real changes, so no other site gets to press its buttons. */
  it("refuses a cross-site answer, undo and refresh", async () => {
    const p = file({ kind: "capture_unfiled", payload: {} });
    const foreign = (method: string) =>
      new Request(`http://localhost/api/desk/${p.id}`, {
        method,
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ decision: "accept" }),
      });
    expect((await r.one.POST(foreign("POST"), ctx(p.id))).status).toBe(403);
    expect((await r.one.DELETE(foreign("DELETE"), ctx(p.id))).status).toBe(403);
    expect((await r.refresh.POST(foreign("POST"))).status).toBe(403);
  });
});

describe("DELETE /api/desk/[id]", () => {
  it("takes an acceptance back and puts the card on the desk again", async () => {
    const c = getDb().insert(containers).values({ kind: "project", name: "Migrations", slug: "migrations", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
    const note = getDb().insert(items).values({ type: "note", title: "Migration notes", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
    const p = file({ kind: "capture_unfiled", payload: { itemId: note.id, containerId: c.id, containerName: "Migrations" } });

    await r.one.POST(json("POST", `/api/desk/${p.id}`, { decision: "accept" }), ctx(p.id));
    const body = await (await r.one.DELETE(json("DELETE", `/api/desk/${p.id}`), ctx(p.id))).json();
    expect(body.undone).toBe(true);
    expect(body.desk.proposals).toHaveLength(1);
  });

  it("says so plainly when there is nothing left to undo, rather than failing", async () => {
    const p = file({ kind: "capture_unfiled", payload: {} });
    const body = await (await r.one.DELETE(json("DELETE", `/api/desk/${p.id}`), ctx(p.id))).json();
    expect(body.undone).toBe(false);
  });
});

describe("POST /api/desk/refresh", () => {
  it("queues the same sweep the interval does", async () => {
    const res = await r.refresh.POST(json("POST", "/api/desk/refresh"));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ queued: expect.any(Number) });
  });
});
