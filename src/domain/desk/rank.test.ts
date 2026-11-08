import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { proposals } from "@/db/schema";
import { setSetting } from "@/domain/settings";
import { dismissRate, rankDraft, weightOf } from "./rank";
import type { ProposalDraft } from "./types";

let t: TestDb;
afterEach(() => t?.cleanup());

function draft(over: Partial<ProposalDraft> = {}): ProposalDraft {
  return { kind: "task_stalled", source: "task", sourceRef: "task:1", title: "t", detail: "d", payload: {}, urgency: 1, ...over };
}

/** `n` decided proposals of one kind, the first `dismissed` of them refused. */
function decided(kind: ProposalDraft["kind"], states: ("accepted" | "dismissed" | "expired")[]) {
  states.forEach((state, i) => {
    t.db
      .insert(proposals)
      .values({
        kind,
        source: "task",
        sourceRef: `${kind}:${i}`,
        title: "t",
        state,
        createdAt: "2026-11-01T00:00:00.000Z",
        // Ascending, so the last of the list is the most recent decision.
        decidedAt: new Date(Date.parse("2026-11-01T00:00:00.000Z") + i * 60_000).toISOString(),
      })
      .run();
  });
}

describe("dismissRate", () => {
  it("is zero with nothing decided yet, so a new kind is never pre-judged", () => {
    t = makeTestDb();
    expect(dismissRate(t.db, "task_stalled")).toBe(0);
  });

  it("is the share of decisions that were refusals", () => {
    t = makeTestDb();
    decided("task_stalled", ["dismissed", "dismissed", "dismissed", "accepted"]);
    expect(dismissRate(t.db, "task_stalled")).toBe(0.75);
  });

  it("counts only decisions: an expiry is the condition resolving itself, not a refusal", () => {
    t = makeTestDb();
    decided("task_stalled", ["expired", "expired", "expired", "dismissed", "accepted"]);
    expect(dismissRate(t.db, "task_stalled")).toBe(0.5);
  });

  it("counts only its own kind", () => {
    t = makeTestDb();
    decided("task_stalled", ["accepted", "accepted"]);
    decided("capture_unfiled", ["dismissed", "dismissed"]);
    expect(dismissRate(t.db, "task_stalled")).toBe(0);
    expect(dismissRate(t.db, "capture_unfiled")).toBe(1);
  });

  /** A change of mind has to be able to show through: thirty decisions back, no further. */
  it("forgets beyond the last thirty decisions", () => {
    t = makeTestDb();
    decided("task_stalled", [...Array(30).fill("dismissed"), ...Array(30).fill("accepted")] as ("accepted" | "dismissed")[]);
    expect(dismissRate(t.db, "task_stalled")).toBe(0);
  });
});

describe("weightOf", () => {
  it("has a default per kind, and a setting overrides it", () => {
    t = makeTestDb();
    expect(weightOf(t.db, "meeting_unprepared")).toBe(1);
    expect(weightOf(t.db, "decision_stale")).toBeLessThan(weightOf(t.db, "meeting_unprepared"));
    setSetting(t.db, "desk.weight.decision_stale", "2");
    expect(weightOf(t.db, "decision_stale")).toBe(2);
  });

  it("ignores a setting that is not a positive number rather than ranking everything at zero", () => {
    t = makeTestDb();
    setSetting(t.db, "desk.weight.task_stalled", "not a number");
    expect(weightOf(t.db, "task_stalled")).toBe(0.6);
    setSetting(t.db, "desk.weight.task_stalled", "0");
    expect(weightOf(t.db, "task_stalled")).toBe(0.6);
  });
});

describe("rankDraft", () => {
  it("is urgency times weight when nothing has been decided", () => {
    t = makeTestDb();
    expect(rankDraft(t.db, draft({ kind: "meeting_unprepared", urgency: 0.5 }))).toBeCloseTo(0.5);
  });

  it("clamps an urgency a generator got wrong rather than letting it jump the queue", () => {
    t = makeTestDb();
    expect(rankDraft(t.db, draft({ kind: "meeting_unprepared", urgency: 7 }))).toBeCloseTo(1);
    expect(rankDraft(t.db, draft({ kind: "meeting_unprepared", urgency: -3 }))).toBe(0);
  });

  /** The learning loop, stated as a test: the kind you always refuse loses to the one you never do. */
  it("sinks a kind that keeps being refused below one that is not, at equal urgency", () => {
    t = makeTestDb();
    decided("capture_unfiled", Array(9).fill("dismissed") as "dismissed"[]);
    const refused = rankDraft(t.db, draft({ kind: "capture_unfiled", urgency: 1 }));
    const fresh = rankDraft(t.db, draft({ kind: "task_stalled", urgency: 1 }));
    expect(refused).toBeLessThan(fresh);
    expect(refused).toBeGreaterThan(0);
  });
});
