import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { proposals } from "@/db/schema";
import { deskPayload } from "./index";

let t: TestDb;
afterEach(() => t?.cleanup());

/** Local midnight on the 11th, and the half hour after it. */
const JUST_AFTER_MIDNIGHT = new Date(2026, 10, 11, 0, 30);

function decided(at: Date) {
  t.db
    .insert(proposals)
    .values({
      kind: "task_stalled",
      source: "task",
      sourceRef: `task:${at.getTime()}`,
      title: "Answer the auditors",
      detail: "",
      payload: "{}",
      rank: 0.5,
      state: "accepted",
      decidedAt: at.toISOString(),
      createdAt: at.toISOString(),
    })
    .run();
}

describe("deskPayload: what counts as answered today", () => {
  /**
   * The bug this exists for: the count compared a UTC timestamp against local midnight written
   * with a `Z` on the end. East of UTC that made every decision between local midnight and UTC
   * midnight read as yesterday's -- here, the first 5.5 hours of every day.
   *
   * Written in local time on both sides deliberately, so it holds in any timezone rather than
   * only in the one that happened to expose it.
   */
  it("counts a decision made just after local midnight, not one from just before it", () => {
    t = makeTestDb();
    decided(new Date(2026, 10, 11, 0, 10));
    decided(new Date(2026, 10, 10, 23, 50));
    expect(deskPayload(t.db, JUST_AFTER_MIDNIGHT).decidedToday).toBe(1);
  });

  it("counts nothing on a day with no decisions", () => {
    t = makeTestDb();
    decided(new Date(2026, 10, 10, 12, 0));
    expect(deskPayload(t.db, JUST_AFTER_MIDNIGHT).decidedToday).toBe(0);
  });
});
