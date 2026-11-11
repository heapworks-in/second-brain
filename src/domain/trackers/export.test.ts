import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { setSetting } from "@/domain/settings";
import { completeTask, createTask, listTasks, updateTask } from "@/domain/tasks";
import { guessMapping, guessStatusMap, statusWords, type Mapping } from "./mapping";
import { applyImport, type ImportInput } from "./import";
import { deleteTracker, listTrackers, trackerSheet } from "./export";
import { readWorkbook, writeWorkbook } from "./sheet";

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
  setSetting(t.db, "identity.names", "Avinash, Avinash V");
});
afterEach(() => t.cleanup());

const HEADERS = ["Theme", "Task", "Sub task", "Owner", "ETA", "Team", "Comments", "Status", "Risk"];
const ROWS = [
  { Theme: "Migration", Task: "Move the database", "Sub task": "Take a backup", Owner: "Priya Raman", ETA: "12/11/2026", Team: "Platform", Comments: "Overnight window", Status: "In Progress", Risk: "High" },
  { Theme: "Migration", Task: "Move the database", "Sub task": "Cut over", Owner: "Avinash", ETA: "mid Nov", Team: "", Comments: "", Status: "Blocked", Risk: "" },
];

function imported(over: Partial<ImportInput> = {}) {
  const columns = guessMapping(HEADERS);
  const mapping: Mapping = { columns, theme: "group" };
  return applyImport(t.db, {
    name: "Q4 Migration",
    containerId: null,
    sourceName: "q4.xlsx",
    sheetName: "Plan",
    headers: HEADERS,
    rows: ROWS,
    mapping,
    statusMap: guessStatusMap(statusWords(ROWS, columns.status)),
    identityNames: ["Avinash", "Avinash V"],
    ...over,
  });
}

describe("trackerSheet", () => {
  it("gives the file back in its own columns, in its own order, with an id column added", () => {
    const { tracker } = imported();
    const sheet = trackerSheet(t.db, tracker.id);
    expect(sheet.headers).toEqual([...HEADERS, "SB ID"]);
    expect(sheet.rows[0]).toMatchObject({
      Theme: "Migration",
      Task: "Move the database",
      "Sub task": "Take a backup",
      Owner: "Priya Raman",
      ETA: "2026-11-12",
      Team: "Platform",
      Comments: "Overnight window",
      Status: "In Progress",
      Risk: "High",
    });
  });

  it("writes my own name in the owner column, as the team spells it", () => {
    const { tracker } = imported();
    expect(trackerSheet(t.db, tracker.id).rows[1].Owner).toBe("Avinash");
  });

  /** The row that would quietly lose something: "mid Nov" is not a date, and an export that
   * replaced it with an empty cell would send the file back poorer than it arrived. */
  /** My own rows have no person behind them -- that is what "mine" means here -- so a team cell
   * on one of them would be blanked by an export that only ever read it off a person. */
  it("keeps the team cell on a row of my own", () => {
    const rows = ROWS.map((r) => (r.Owner === "Avinash" ? { ...r, Team: "Platform" } : r));
    const { tracker } = imported({ rows });
    const sheet = trackerSheet(t.db, tracker.id);
    expect(sheet.rows[1]).toMatchObject({ Owner: "Avinash", Team: "Platform" });
  });

  it("keeps an ETA that was never a date", () => {
    const { tracker } = imported();
    expect(trackerSheet(t.db, tracker.id).rows[1].ETA).toBe("mid Nov");
  });

  it("writes back what changed here, in the words the team reads", () => {
    const { tracker } = imported();
    const mine = listTasks(t.db, { trackerId: tracker.id, status: "all" })[0];
    completeTask(t.db, mine.id);
    const row = trackerSheet(t.db, tracker.id).rows.find((r) => r["Sub task"] === "Cut over")!;
    expect(row.Status).toBe("Done");
  });

  it("survives the round trip through a real xlsx file", async () => {
    const { tracker } = imported();
    const sheet = trackerSheet(t.db, tracker.id);
    const buffer = await writeWorkbook(sheet);
    const [back] = await readWorkbook(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
    expect(back.headers).toEqual(sheet.headers);
    // Cell by cell across every column: a value the export left out is the same empty cell the
    // file comes back with, so the comparison is of the sheet rather than of the object shape.
    const cells = (rows: Record<string, string>[]) => rows.map((r) => sheet.headers.map((h) => r[h] ?? ""));
    expect(cells(back.rows)).toEqual(cells(sheet.rows));
  });

  it("re-imports its own export as updates, matched on the id column", async () => {
    const { tracker } = imported();
    const sheet = trackerSheet(t.db, tracker.id);
    // The file comes back with a row renamed -- the id column is what keeps it the same row.
    const edited = sheet.rows.map((r) => (r["Sub task"] === "Cut over" ? { ...r, "Sub task": "Cut over (Sunday)" } : r));
    const columns = guessMapping(sheet.headers);
    const again = imported({ headers: sheet.headers, rows: edited, mapping: { columns, theme: "group" }, trackerId: tracker.id });
    expect([again.created, again.updated]).toEqual([0, 2]);
    expect(listTasks(t.db, { trackerId: tracker.id, status: "all", owner: "anyone" }).map((r) => r.title).sort()).toEqual(["Cut over (Sunday)", "Take a backup"]);
  });
});

describe("deleteTracker", () => {
  it("keeps the rows as ordinary tasks, and strips the sheet's own columns off them", () => {
    const { tracker } = imported();
    const out = deleteTracker(t.db, tracker.id, "keep");
    expect(out.deletedRows).toBe(0);
    expect(listTrackers(t.db)).toHaveLength(0);
    const kept = listTasks(t.db, { status: "all", owner: "anyone" });
    expect(kept).toHaveLength(2);
    expect(kept.every((k) => k.trackerId === null && k.theme === "" && k.sheetExtra === "{}")).toBe(true);
  });

  it("takes the rows with it when that is what was asked", () => {
    const { tracker } = imported();
    expect(deleteTracker(t.db, tracker.id, "delete").deletedRows).toBe(2);
    expect(listTasks(t.db, { status: "all", owner: "anyone" })).toHaveLength(0);
  });
});

describe("listTrackers", () => {
  it("says what each one holds, and how much of it is mine", () => {
    const { tracker } = imported();
    const extra = createTask(t.db, { title: "Added here", trackerId: tracker.id });
    updateTask(t.db, extra.id, { status: "done" });
    const [row] = listTrackers(t.db);
    expect(row.counts).toEqual({ rows: 3, open: 2, done: 1, mine: 2 });
  });
});
