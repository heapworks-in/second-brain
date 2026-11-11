import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { createPerson, listPeople } from "@/domain/people";
import { listContainers } from "@/domain/containers";
import { completeTask, getTask, listTasks } from "@/domain/tasks";
import { guessMapping, guessStatusMap, statusWords, type Mapping } from "./mapping";
import { applyImport, previewImport, type ImportInput } from "./import";

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => t.cleanup());

const HEADERS = ["Theme", "Task", "Sub task", "Owner", "ETA", "Team", "Comments", "Status", "Risk"];

/** The shape a real tracker has: a theme and a task repeated down the rows, sub-tasks under them,
 * one column (Risk) the app knows nothing about, and a status word it has no opinion on. */
const ROWS = [
  { Theme: "Migration", Task: "Move the database", "Sub task": "Take a backup", Owner: "Priya Raman", ETA: "12/11/2026", Team: "Platform", Comments: "Overnight window", Status: "In Progress", Risk: "High" },
  { Theme: "Migration", Task: "Move the database", "Sub task": "Cut over", Owner: "Avinash", ETA: "13/11/2026", Team: "Platform", Comments: "", Status: "Blocked", Risk: "High" },
  { Theme: "Reporting", Task: "Weekly dashboard", "Sub task": "", Owner: "Sam Okoro", ETA: "mid Nov", Team: "Data", Comments: "Waiting on the schema", Status: "Done", Risk: "" },
];

function input(over: Partial<ImportInput> = {}): ImportInput {
  const columns = guessMapping(HEADERS);
  const mapping: Mapping = { columns, theme: "group" };
  return {
    name: "Q4 Migration",
    containerId: null,
    sourceName: "q4-migration.xlsx",
    sheetName: "Plan",
    headers: HEADERS,
    rows: ROWS,
    mapping,
    statusMap: guessStatusMap(statusWords(ROWS, columns.status)),
    identityNames: ["Avinash"],
    ...over,
  };
}

describe("previewImport", () => {
  it("writes nothing and says what each row would become", () => {
    const plan = previewImport(t.db, input());
    expect(plan.counts).toEqual({ create: 3, update: 0, skip: 0 });
    expect(listTasks(t.db, { owner: "anyone", status: "all" })).toHaveLength(0);
    expect(listPeople(t.db)).toHaveLength(0);

    expect(plan.rows[0]).toMatchObject({
      row: 1,
      theme: "Migration",
      parentLabel: "Move the database",
      title: "Take a backup",
      ownerName: "Priya Raman",
      dueDate: "2026-11-12",
      notes: "Overnight window",
      status: "open",
      statusLabel: "In Progress",
      verdict: "create",
    });
    // The column nobody mapped rides along verbatim, which is what makes an export faithful.
    expect(plan.rows[0].sheetExtra).toEqual({ Risk: "High" });
    expect(plan.keptColumns).toEqual(["Risk"]);
  });

  it("knows which rows are mine from the identity setting", () => {
    const plan = previewImport(t.db, input());
    expect(plan.people).toEqual([
      { name: "Priya Raman", personId: null, isMe: false, rows: 1 },
      { name: "Avinash", personId: null, isMe: true, rows: 1 },
      { name: "Sam Okoro", personId: null, isMe: false, rows: 1 },
    ]);
  });

  it("matches an owner who already exists here rather than offering to create them again", () => {
    const priya = createPerson(t.db, { name: "priya raman" });
    expect(previewImport(t.db, input()).people[0]).toEqual({ name: "Priya Raman", personId: priya.id, isMe: false, rows: 1 });
  });

  it("reports what it could not read instead of guessing it", () => {
    const plan = previewImport(t.db, input());
    expect(plan.unknownStatuses).toEqual(["In Progress", "Blocked"]);
    expect(plan.unparsedEtas).toEqual([{ row: 3, text: "mid Nov" }]);
  });

  it("skips a row with no task and a row that repeats one, naming the reason", () => {
    const rows = [...ROWS, { ...ROWS[0] }, { Theme: "Migration", Task: "", "Sub task": "", Owner: "Priya Raman", ETA: "", Team: "", Comments: "orphan", Status: "", Risk: "" }];
    const plan = previewImport(t.db, input({ rows }));
    expect(plan.counts).toEqual({ create: 3, update: 0, skip: 2 });
    expect(plan.rows[3]).toMatchObject({ verdict: "skip", reason: "the same row appears twice in the file" });
    expect(plan.rows[4]).toMatchObject({ verdict: "skip", reason: "no task or sub-task to name it" });
  });
});

describe("applyImport", () => {
  it("creates the people, the tracker and the rows, and leaves my lists alone", () => {
    const out = applyImport(t.db, input());
    expect(out.created).toBe(3);
    expect(out.peopleCreated).toEqual(["Priya Raman", "Sam Okoro"]);
    expect(out.tracker.slug).toBe("q4-migration");

    // The whole sheet is here when asked for by name...
    const all = listTasks(t.db, { trackerId: out.tracker.id, status: "all", owner: "anyone" });
    expect(all).toHaveLength(3);
    // ...and only my own row is in the list every other surface reads.
    expect(listTasks(t.db, { status: "all" }).map((x) => x.title)).toEqual(["Cut over"]);
  });

  it("takes the team from the sheet for a person it creates, and never overwrites one", () => {
    createPerson(t.db, { name: "Sam Okoro", team: "Analytics" });
    applyImport(t.db, input());
    const people = new Map(listPeople(t.db).map((p) => [p.name, p.team]));
    expect(people.get("Priya Raman")).toBe("Platform");
    expect(people.get("Sam Okoro")).toBe("Analytics");
  });

  it("keeps the sheet's own status word beside the lifecycle the app reasons with", () => {
    const out = applyImport(t.db, input());
    const rows = listTasks(t.db, { trackerId: out.tracker.id, status: "all", owner: "anyone" });
    const blocked = rows.find((r) => r.title === "Cut over")!;
    expect([blocked.status, blocked.statusLabel]).toEqual(["open", "Blocked"]);
    const done = rows.find((r) => r.title === "Weekly dashboard")!;
    expect([done.status, done.statusLabel]).toEqual(["done", "Done"]);
    // Imported as done, but nobody knows when: a guessed date would land it in this week's review.
    expect(done.completedAt).toBeNull();
  });

  it("re-imports its own file as updates, not duplicates", () => {
    const first = applyImport(t.db, input());
    const changed = ROWS.map((r) => (r["Sub task"] === "Cut over" ? { ...r, ETA: "20/11/2026", Status: "Done" } : r));
    const second = applyImport(t.db, input({ rows: changed, trackerId: first.tracker.id }));
    expect([second.created, second.updated]).toEqual([0, 3]);
    expect(listTasks(t.db, { trackerId: first.tracker.id, status: "all", owner: "anyone" })).toHaveLength(3);
    const mine = listTasks(t.db, { status: "all" })[0];
    expect([mine.dueDate, mine.status, mine.statusLabel]).toEqual(["2026-11-20", "done", "Done"]);
  });

  it("files each row in a project of its own when Theme is read that way", () => {
    const columns = guessMapping(HEADERS);
    const out = applyImport(t.db, input({ mapping: { columns, theme: "container" } }));
    expect(listContainers(t.db, { kind: "project" }).map((c) => c.name).sort()).toEqual(["Migration", "Reporting"]);
    const rows = listTasks(t.db, { trackerId: out.tracker.id, status: "all", owner: "anyone" });
    // The theme became the home, so it is not also kept as a label on the row.
    expect(rows.every((r) => r.theme === "")).toBe(true);
    expect(new Set(rows.map((r) => r.containerId)).size).toBe(2);
  });

  it("finishing an imported row rewrites the word the team reads", () => {
    const out = applyImport(t.db, input());
    const blocked = listTasks(t.db, { trackerId: out.tracker.id, status: "all", owner: "anyone" }).find((r) => r.title === "Cut over")!;
    completeTask(t.db, blocked.id);
    expect(getTask(t.db, blocked.id)!.statusLabel).toBe("Done");
  });
});
