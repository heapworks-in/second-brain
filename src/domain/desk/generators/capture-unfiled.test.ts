import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { containers, items } from "@/db/schema";
import { rechunkItem } from "@/domain/items";
import { setSetting } from "@/domain/settings";
import { captureUnfiled } from "./capture-unfiled";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY_MS).toISOString();
}

function container(name: string) {
  return t.db.insert(containers).values({ kind: "project", name, slug: name.toLowerCase().replace(/\W+/g, "-"), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
}

/** An item, indexed for search the way the embed job would leave it. */
function note(title: string, over: Partial<typeof items.$inferInsert> = {}) {
  const row = t.db
    .insert(items)
    .values({ type: "note", title, body: title, createdAt: daysAgo(30), updatedAt: daysAgo(30), ...over })
    .returning()
    .get();
  rechunkItem(t.db, row.id);
  return row;
}

describe("captureUnfiled", () => {
  it("names the container the closest filed note already sits in", () => {
    t = makeTestDb();
    const migrations = container("Migrations");
    note("Migration rollback runbook", { containerId: migrations.id });
    const orphan = note("Migration notes from the call");

    const [p] = captureUnfiled(t.db, NOW);
    expect(p.title).toBe("Migration notes from the call");
    expect(p.detail).toBe("Captured 30 days ago, still unfiled. Closest match sits in Migrations.");
    expect(p.payload).toMatchObject({ itemId: orphan.id, containerId: migrations.id, containerName: "Migrations" });
  });

  /**
   * The rule that keeps this a decision rather than a reminder: with nothing to be similar to,
   * the card cannot name a destination, so there is no card.
   */
  it("says nothing at all when it cannot name where the thing would go", () => {
    t = makeTestDb();
    note("Something with no relatives anywhere");
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  it("ignores a filed note as a candidate when it is only similar to unfiled ones", () => {
    t = makeTestDb();
    note("Migration notes one");
    note("Migration notes two");
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  it("is quiet about a fresh capture, and the age is a setting", () => {
    t = makeTestDb();
    const c = container("Migrations");
    note("Migration rollback runbook", { containerId: c.id });
    note("Migration notes from the call", { createdAt: daysAgo(2), updatedAt: daysAgo(2) });
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
    setSetting(t.db, "desk.captureUnfiledDays", "1");
    expect(captureUnfiled(t.db, NOW)).toHaveLength(1);
  });

  it("is quiet about anything already filed, archived or failed", () => {
    t = makeTestDb();
    const c = container("Migrations");
    note("Migration rollback runbook", { containerId: c.id });
    note("Migration one", { containerId: c.id });
    note("Migration two", { archivedAt: NOW.toISOString() });
    note("Migration three", { status: "failed" });
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  /** A journal entry and a weekly review belong to a date, not to a project. */
  it("is quiet about journals and reviews, which have no container to want", () => {
    t = makeTestDb();
    const c = container("Migrations");
    note("Migration rollback runbook", { containerId: c.id });
    note("Migration thoughts", { type: "journal", journalDate: "2026-10-09" });
    note("Migration week", { type: "review", reviewWeek: "2026-W41" });
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  it("stays slow: an ancient capture never shouts louder than a meeting", () => {
    t = makeTestDb();
    const c = container("Migrations");
    note("Migration rollback runbook", { containerId: c.id });
    note("Migration notes", { createdAt: daysAgo(900), updatedAt: daysAgo(900) });
    expect(captureUnfiled(t.db, NOW)[0].urgency).toBeLessThanOrEqual(0.6);
  });
});
