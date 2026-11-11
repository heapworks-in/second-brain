import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { focusRuns } from "@/db/schema";
import { createContainer } from "@/domain/containers";
import { createPerson, deletePerson } from "@/domain/people";
import { addToPlan } from "@/domain/plan";
import { addBlock } from "@/domain/blocks";
import { startFocus, estimateActualPairs } from "@/domain/focus";
import { collectDrafts } from "@/domain/desk/generators";
import { setSetting } from "@/domain/settings";
import { plannerDay } from "@/lib/planner";
import { homePayload } from "@/lib/home";
import { reviewPayload } from "@/lib/review";
import { completeTask, containerProgress, createTask, listTasks, requireMine, TaskError } from "./index";

/**
 * The one test that earns the `MINE` predicate.
 *
 * A tracker is two hundred rows of which six are mine. Every surface below reads `tasks`
 * directly, and one of them forgetting the predicate does not fail loudly -- it quietly fills my
 * week, my capacity line and my desk with other people's work. So each surface gets a case here,
 * and the fixture is deliberately the worst one: a teammate's row that would qualify for every
 * single card and count if ownership were ignored.
 */
describe("a teammate's row never reaches a surface that means 'my work'", () => {
  let t: TestDb;
  const DATE = "2026-11-10";
  const NOW = new Date(2026, 10, 10, 9, 0);
  let projectId: number;
  let priyaId: number;

  beforeEach(() => {
    t = makeTestDb();
    projectId = createContainer(t.db, { kind: "project", name: "Launch" }).id;
    priyaId = createPerson(t.db, { name: "Priya Raman" }).id;
  });
  afterEach(() => t.cleanup());

  /** Theirs: overdue, estimated, asked for days ago, and in my project. Qualifies for everything. */
  function theirs(over: Record<string, unknown> = {}) {
    return createTask(t.db, {
      title: "Their row",
      containerId: projectId,
      dueDate: "2026-11-01",
      estimateMinutes: 30,
      requesterPersonId: priyaId,
      askedOn: "2026-11-01",
      ownerPersonId: priyaId,
      ...over,
    });
  }

  it("is left out of listTasks unless it is asked for by name", () => {
    const row = theirs();
    expect(listTasks(t.db, {})).toHaveLength(0);
    expect(listTasks(t.db, { containerId: projectId })).toHaveLength(0);
    expect(listTasks(t.db, { requester: "any" })).toHaveLength(0);
    expect(listTasks(t.db, { owner: "anyone" }).map((x) => x.id)).toEqual([row.id]);
    expect(listTasks(t.db, { owner: priyaId }).map((x) => x.id)).toEqual([row.id]);
  });

  it("is in none of the planner's sources, so it can never reach a day's plan", () => {
    theirs();
    const { sources } = plannerDay(t.db, DATE, NOW);
    expect(sources.inbox).toHaveLength(0);
    expect(sources.owed).toHaveLength(0);
    expect(sources.due.overdue).toHaveLength(0);
    expect(sources.projects.flatMap((g) => g.tasks)).toHaveLength(0);
  });

  it("is in none of Home's counts", () => {
    theirs();
    const home = homePayload(t.db, NOW);
    expect(home.counts.planned).toBe(0);
    expect(home.day.sources.inbox).toHaveLength(0);
  });

  it("is in no card the desk can raise", () => {
    theirs();
    // Every threshold at its lowest, so nothing here is quiet merely because it is too recent.
    setSetting(t.db, "desk.owedWaitDays", "1");
    setSetting(t.db, "desk.stalledPlanDays", "1");
    expect(collectDrafts(t.db, NOW)).toHaveLength(0);
  });

  it("is in neither half of the week's review", () => {
    const row = theirs();
    completeTask(t.db, row.id);
    const review = reviewPayload(t.db, "2026-11-09", NOW);
    expect(review.back.done).toBe(0);
    expect(review.back.projects).toHaveLength(0);
  });

  it("is in no figure measured from how long my work takes", () => {
    const mine = createTask(t.db, { title: "Write the brief", containerId: projectId, estimateMinutes: 30 });
    const row = theirs({ title: "Write the brief" });
    // Written straight into the table: `startFocus` now refuses a task that is not mine, so the
    // only way this data exists is an import or a row handed over after the fact -- which is
    // exactly the case the predicate on the read side is there for.
    for (const taskId of [mine.id, row.id]) {
      t.db
        .insert(focusRuns)
        .values({ taskId, plannedMinutes: 30, actualMinutes: 45, outcome: "completed", startedAt: NOW.toISOString(), endedAt: NOW.toISOString() })
        .run();
      completeTask(t.db, taskId);
    }
    // One pair, not two: how long a teammate's row took says nothing about my estimating.
    expect(estimateActualPairs(t.db)).toHaveLength(1);
  });

  it("counts toward the project's percent, but is never what I am told to do next", () => {
    theirs();
    const mine = createTask(t.db, { title: "Mine", containerId: projectId });
    const p = containerProgress(t.db, [projectId]).get(projectId)!;
    // Two open rows in the project, because the project really does have two.
    expect(p.open).toBe(2);
    expect(p.nextTask?.id).toBe(mine.id);
  });

  it("cannot be planned, blocked or run: the honest answer is to take it over", () => {
    const row = theirs();
    expect(() => addToPlan(t.db, DATE, row.id)).toThrow(/Priya Raman's/);
    expect(() => addBlock(t.db, { taskId: row.id, startsAt: `${DATE}T14:00`, minutes: 30 })).toThrow(/take it over/);
    expect(() => startFocus(t.db, { taskId: row.id }, NOW)).toThrow(/take it over/);
    expect(() => requireMine(t.db, row.id)).toThrow(TaskError);
  });

  /** Deleting a person must not strand their rows: `on delete set null` hands them back to me,
   * which is the only owner left who can do anything with them. */
  it("becomes mine again when the person is deleted", () => {
    const row = theirs();
    deletePerson(t.db, priyaId);
    expect(listTasks(t.db, {}).map((x) => x.id)).toEqual([row.id]);
    expect(requireMine(t.db, row.id).ownerPersonId).toBeNull();
  });
});
