import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "@/test/db";
import { proposals } from "@/db/schema";
import { reconcileProposals, openProposals } from "./reconcile";
import type { ProposalDraft } from "./types";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");

function draft(over: Partial<ProposalDraft> = {}): ProposalDraft {
  return {
    kind: "task_stalled",
    source: "task",
    sourceRef: "task:1",
    title: "Planned three days, never started",
    detail: "On the plan Mon, Tue, Wed. No focus minutes.",
    payload: { taskId: 1 },
    urgency: 0.5,
    ...over,
  };
}

/** The row behind a `(kind, sourceRef)`, whatever state it is in. */
function row(ref = "task:1", kind: ProposalDraft["kind"] = "task_stalled") {
  t.db.select().from(proposals).all();
  return t.db.select().from(proposals).where(eq(proposals.sourceRef, ref)).all().find((r) => r.kind === kind)!;
}

describe("reconcileProposals", () => {
  it("files a draft it has never seen", () => {
    t = makeTestDb();
    expect(reconcileProposals(t.db, [draft()], NOW)).toMatchObject({ opened: 1, expired: 0, returned: 0 });
    expect(row()).toMatchObject({ state: "open", title: "Planned three days, never started", createdAt: NOW.toISOString() });
  });

  it("refreshes the evidence on a second sweep without filing a second row or moving createdAt", () => {
    t = makeTestDb();
    reconcileProposals(t.db, [draft()], NOW);
    const later = new Date("2026-11-08T12:00:00.000Z");
    const result = reconcileProposals(t.db, [draft({ detail: "On the plan four days now." })], later);
    expect(result).toMatchObject({ opened: 0, refreshed: 1 });
    expect(t.db.select().from(proposals).all()).toHaveLength(1);
    expect(row()).toMatchObject({ detail: "On the plan four days now.", createdAt: NOW.toISOString() });
  });

  /**
   * The case the whole surface rests on. A dismissed proposal whose condition is still true is
   * re-emitted by its generator on every sweep, fifteen minutes apart, forever. If reconciling
   * reopened it, the desk would re-ask everything within the quarter hour and be worth nothing.
   */
  it("leaves a dismissed proposal dismissed however many times its generator re-emits it", () => {
    t = makeTestDb();
    reconcileProposals(t.db, [draft()], NOW);
    t.db.update(proposals).set({ state: "dismissed", decidedAt: NOW.toISOString() }).where(eq(proposals.id, row().id)).run();

    for (let i = 0; i < 3; i += 1) reconcileProposals(t.db, [draft()], new Date(NOW.getTime() + (i + 1) * 900_000));

    expect(row().state).toBe("dismissed");
    expect(openProposals(t.db, 7)).toHaveLength(0);
  });

  it("leaves an accepted proposal accepted too", () => {
    t = makeTestDb();
    reconcileProposals(t.db, [draft()], NOW);
    t.db.update(proposals).set({ state: "accepted", decidedAt: NOW.toISOString() }).where(eq(proposals.id, row().id)).run();
    reconcileProposals(t.db, [draft()], NOW);
    expect(row().state).toBe("accepted");
  });

  it("expires an open proposal its generator has stopped emitting", () => {
    t = makeTestDb();
    reconcileProposals(t.db, [draft()], NOW);
    const result = reconcileProposals(t.db, [], new Date("2026-11-08T10:00:00.000Z"));
    expect(result).toMatchObject({ expired: 1 });
    expect(row()).toMatchObject({ state: "expired", decidedAt: "2026-11-08T10:00:00.000Z" });
  });

  it("does not expire a dismissed or snoozed row just because nothing emitted it", () => {
    t = makeTestDb();
    reconcileProposals(t.db, [draft({ sourceRef: "task:1" }), draft({ sourceRef: "task:2" })], NOW);
    t.db.update(proposals).set({ state: "dismissed" }).where(eq(proposals.sourceRef, "task:1")).run();
    t.db.update(proposals).set({ state: "snoozed", snoozedUntil: "2026-12-01T00:00:00.000Z" }).where(eq(proposals.sourceRef, "task:2")).run();
    expect(reconcileProposals(t.db, [], NOW)).toMatchObject({ expired: 0 });
    expect(row("task:1").state).toBe("dismissed");
    expect(row("task:2").state).toBe("snoozed");
  });

  it("returns a snoozed proposal to the desk once its snooze has run out", () => {
    t = makeTestDb();
    reconcileProposals(t.db, [draft()], NOW);
    t.db.update(proposals).set({ state: "snoozed", snoozedUntil: "2026-11-15T09:00:00.000Z" }).where(eq(proposals.id, row().id)).run();

    const early = reconcileProposals(t.db, [draft()], new Date("2026-11-14T09:00:00.000Z"));
    expect(early.returned).toBe(0);
    expect(row().state).toBe("snoozed");

    const due = reconcileProposals(t.db, [draft()], new Date("2026-11-15T09:00:01.000Z"));
    expect(due.returned).toBe(1);
    expect(row()).toMatchObject({ state: "open", snoozedUntil: null });
  });

  it("a snooze that runs out with its cause gone comes back only to expire", () => {
    t = makeTestDb();
    reconcileProposals(t.db, [draft()], NOW);
    t.db.update(proposals).set({ state: "snoozed", snoozedUntil: "2026-11-15T09:00:00.000Z" }).where(eq(proposals.id, row().id)).run();
    const result = reconcileProposals(t.db, [], new Date("2026-11-16T09:00:00.000Z"));
    expect(result).toMatchObject({ returned: 1, expired: 1 });
    expect(row().state).toBe("expired");
  });

  it("tells the same kind apart by sourceRef, and the same ref apart by kind", () => {
    t = makeTestDb();
    reconcileProposals(
      t.db,
      [draft({ sourceRef: "task:1" }), draft({ sourceRef: "task:2" }), draft({ kind: "task_overrun", sourceRef: "task:1" })],
      NOW,
    );
    expect(t.db.select().from(proposals).all()).toHaveLength(3);
  });

  it("orders the desk by rank, and breaks a tie on which was noticed first", () => {
    t = makeTestDb();
    reconcileProposals(t.db, [draft({ sourceRef: "task:1", urgency: 0.2 })], NOW);
    reconcileProposals(
      t.db,
      [draft({ sourceRef: "task:1", urgency: 0.2 }), draft({ sourceRef: "task:2", urgency: 0.9 })],
      new Date("2026-11-08T10:00:00.000Z"),
    );
    expect(openProposals(t.db, 7).map((p) => p.sourceRef)).toEqual(["task:2", "task:1"]);
  });
});
