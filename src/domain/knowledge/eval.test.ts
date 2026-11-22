import { describe, it, expect, afterEach, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { captureNote } from "@/domain/items/capture";
import type { ChatProvider } from "@/providers/chat";
import { runEval, runRefusalEval } from "./eval";

let t: TestDb;
afterEach(() => t?.cleanup());

function corpus() {
  t = makeTestDb();
  captureNote(t.db, { title: "Migration plan", body: "We froze schema changes until the audit finishes. Priya owns the rollback." });
  captureNote(t.db, { title: "Hiring loop", body: "The onsite is four interviews and a debrief the same afternoon." });
}

const chat = (answer: unknown): ChatProvider => ({ structured: vi.fn().mockResolvedValue(answer) });

describe("runEval", () => {
  it("scores recall and whether the right thing came first", async () => {
    corpus();
    const report = await runEval(t.db, null, [{ question: "schema freeze audit", expect: ["Migration plan"] }]);
    expect(report.recall).toBe(1);
    expect(report.precisionAtOne).toBe(1);
    expect(report.cleanliness).toBe(1);
  });

  it("notices when the expected document does not come back", async () => {
    corpus();
    const report = await runEval(t.db, null, [{ question: "onsite debrief", expect: ["Migration plan"] }]);
    expect(report.recall).toBe(0);
  });

  /* The failure nobody looks for: one document that matches everything. Recall goes UP when a
   * sprawling transcript ranks into the top three of every unrelated question. */
  it("catches a document intruding where it does not belong", async () => {
    corpus();
    const report = await runEval(t.db, null, [{ question: "schema freeze audit", expect: ["Migration plan"], forbid: ["Migration plan"] }]);
    expect(report.cleanliness).toBe(0);
    expect(report.cases[0].intruders).toEqual(["Migration plan"]);
  });
});

describe("runRefusalEval", () => {
  /* Measured through the answer path, not through retrieval scores. Retrieval cannot refuse --
   * asked about something absent it returns its best ten matches, because that is what ranking
   * does. Only the model reading those sources can decline. */
  it("credits a refusal", async () => {
    corpus();
    const report = await runRefusalEval(t.db, { embed: null, chat: chat({ answer: "", used: [] }) }, [{ question: "what did we decide about pricing?" }]);
    expect(report.refusalRate).toBe(1);
    expect(report.invented).toEqual([]);
  });

  /* What is left for an eval to catch once the claim check is in front of it. An answer made of
   * invented words no longer reaches here -- `verifyClaims` removes it -- so the residue is an
   * answer built honestly out of the sources that simply is not an answer to the question. No
   * check on provenance can see that, because every word of it is genuinely in the notes. */
  it("names what it answered with when it should have declined", async () => {
    corpus();
    const report = await runRefusalEval(
      t.db,
      { embed: null, chat: chat({ answer: "The audit finishes before the freeze lifts [1].", used: [1] }) },
      [{ question: "what did we decide about pricing?" }],
    );
    expect(report.refusalRate).toBe(0);
    expect(report.invented[0].answered).toContain("audit");
  });
});
