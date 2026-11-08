import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { predictions } from "@/db/schema";
import { predictionDue } from "./prediction-due";

let t: TestDb;
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");

function prediction(over: Partial<typeof predictions.$inferInsert> = {}) {
  return t.db
    .insert(predictions)
    .values({
      kind: "estimate",
      claim: "The migration takes under a day",
      resolveBy: "2026-11-01",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      ...over,
    })
    .returning()
    .get();
}

describe("predictionDue", () => {
  it("asks about a call whose answer is knowable and unscored", () => {
    t = makeTestDb();
    const p1 = prediction();
    const [p] = predictionDue(t.db, NOW);
    expect(p.title).toBe("The migration takes under a day");
    expect(p.detail).toBe("Due 7 days ago. What did it actually take?");
    expect(p.payload).toMatchObject({ predictionId: p1.id, kind: "estimate" });
  });

  it("asks in the shape the answer takes", () => {
    t = makeTestDb();
    prediction({ kind: "risk", claim: "The vendor slips", probability: 0.7 });
    expect(predictionDue(t.db, NOW)[0].detail).toContain("Did it happen?");
    t.cleanup();
    t = makeTestDb();
    prediction({ kind: "call", claim: "They pick Postgres" });
    expect(predictionDue(t.db, NOW)[0].detail).toContain("Were you right?");
  });

  it("says due today on the day itself", () => {
    t = makeTestDb();
    prediction({ resolveBy: "2026-11-08" });
    expect(predictionDue(t.db, NOW)[0].detail).toBe("Due today. What did it actually take?");
  });

  it("is quiet about a call not yet knowable, and about one already scored", () => {
    t = makeTestDb();
    prediction({ resolveBy: "2026-12-01" });
    prediction({ resolvedAt: NOW.toISOString(), actual: 3 });
    expect(predictionDue(t.db, NOW)).toHaveLength(0);
  });

  it("grows while it waits and then saturates", () => {
    t = makeTestDb();
    prediction({ resolveBy: "2026-11-07" });
    const day = predictionDue(t.db, NOW)[0].urgency;
    t.cleanup();
    t = makeTestDb();
    prediction({ resolveBy: "2026-01-01" });
    expect(predictionDue(t.db, NOW)[0].urgency).toBe(1);
    expect(day).toBeLessThan(1);
  });
});
