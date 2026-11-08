import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { containers, items } from "@/db/schema";
import { setSetting } from "@/domain/settings";
import { captureUnfiled } from "./capture-unfiled";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY_MS).toISOString();
}

function container(name: string, kind: "project" | "area" | "resource" = "project") {
  return t.db
    .insert(containers)
    .values({ kind, name, slug: name.toLowerCase().replace(/\W+/g, "-"), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
    .returning()
    .get();
}

function note(title: string, over: Partial<typeof items.$inferInsert> = {}) {
  return t.db
    .insert(items)
    .values({ type: "note", title, createdAt: daysAgo(30), updatedAt: daysAgo(30), ...over })
    .returning()
    .get();
}

describe("captureUnfiled", () => {
  it("names the project whose name the capture shares a real word with", () => {
    t = makeTestDb();
    const migrations = container("Migrations");
    const orphan = note("Migrations notes from the call");

    const [p] = captureUnfiled(t.db, NOW);
    expect(p.title).toBe("Migrations notes from the call");
    expect(p.detail).toBe("Captured 30 days ago, still unfiled. Looks like Migrations.");
    expect(p.payload).toMatchObject({ itemId: orphan.id, containerId: migrations.id, containerName: "Migrations" });
  });

  /**
   * The rule that keeps this a decision rather than a reminder: with nowhere to point, there is
   * no card. This is also the regression guard for what the live database caught — an FTS-ranked
   * version offered to file a public holiday into a project called "Task 8 Verification Project",
   * because an OR of prefix-matched terms always finds something.
   */
  it("says nothing when no container name has anything in common with it", () => {
    t = makeTestDb();
    container("Task 8 Verification Project");
    note("Mahatma Gandhi's Birthday");
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  /** Exact words, no stemming: the rule is shared with the meeting suggester and the estimate
   * hint (`MIN_SIGNIFICANT_WORD_LENGTH`), so "Migration" does not reach "Migrations". It makes
   * this card quieter than it could be, which is the right direction for a card whose value is
   * that its answer can be trusted without checking. */
  it("does not stem: a near-miss on the name is not a match", () => {
    t = makeTestDb();
    container("Migrations");
    note("Migration notes from the call");
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  it("will not match on a short word, which would match almost anything", () => {
    t = makeTestDb();
    container("Ops");
    note("Ops at the end of the day");
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  /** A resource is a reference shelf, not somewhere work reports to. */
  it("never suggests a resource", () => {
    t = makeTestDb();
    container("Migrations", "resource");
    note("Migration notes from the call");
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  it("is quiet about a fresh capture, and the age is a setting", () => {
    t = makeTestDb();
    container("Migrations");
    note("Migrations notes", { createdAt: daysAgo(2), updatedAt: daysAgo(2) });
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
    setSetting(t.db, "desk.captureUnfiledDays", "1");
    expect(captureUnfiled(t.db, NOW)).toHaveLength(1);
  });

  it("is quiet about anything already filed, archived or failed", () => {
    t = makeTestDb();
    const c = container("Migrations");
    note("Migration one", { containerId: c.id });
    note("Migration two", { archivedAt: NOW.toISOString() });
    note("Migration three", { status: "failed" });
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  it("is quiet about journals and reviews, which have no container to want", () => {
    t = makeTestDb();
    container("Migrations");
    note("Migration thoughts", { type: "journal", journalDate: "2026-10-09" });
    note("Migration week", { type: "review", reviewWeek: "2026-W41" });
    expect(captureUnfiled(t.db, NOW)).toHaveLength(0);
  });

  it("stays slow: an ancient capture never shouts louder than a meeting", () => {
    t = makeTestDb();
    container("Migrations");
    note("Migrations notes", { createdAt: daysAgo(900), updatedAt: daysAgo(900) });
    expect(captureUnfiled(t.db, NOW)[0].urgency).toBeLessThanOrEqual(0.6);
  });

  it("handles a pile of captures without going quadratic on the suggester", () => {
    t = makeTestDb();
    container("Migrations");
    for (let i = 0; i < 12; i += 1) note(`Migrations note ${i}`);
    expect(captureUnfiled(t.db, NOW)).toHaveLength(12);
  });
});
