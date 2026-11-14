import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "@/test/db";
import { containers, dailyPlanEntries, items, meetingSeriesDecisions, observations, predictions, proposals, tasks } from "@/db/schema";
import { getItem, listItems } from "@/domain/items";
import { getTask, listTasks } from "@/domain/tasks";
import { listPlan } from "@/domain/plan";
import { ingestObservations } from "@/domain/observations";
import { createPerson, listPeople } from "@/domain/people";
import { acceptMeetingAction } from "@/domain/meetings/actions";
import { DeskError, decideProposal, resetUndos, undoProposal } from "./decide";
import type { ProposalDraft } from "./types";
import { reconcileProposals } from "./reconcile";

let t: TestDb;
beforeEach(() => resetUndos());
afterEach(() => t?.cleanup());

const NOW = new Date("2026-11-08T09:00:00.000Z");

/** File one draft and hand back its row, so each test starts from a real open proposal. */
function open(draft: Partial<ProposalDraft> & Pick<ProposalDraft, "kind" | "payload">) {
  reconcileProposals(
    t.db,
    [{ source: "task", sourceRef: `${draft.kind}:1`, title: "A card", detail: "", urgency: 0.5, ...draft } as ProposalDraft],
    NOW,
  );
  return t.db.select().from(proposals).where(eq(proposals.kind, draft.kind)).get()!;
}

function state(id: number) {
  return t.db.select().from(proposals).where(eq(proposals.id, id)).get()!;
}

describe("decideProposal", () => {
  it("refuses a proposal that is not there, and one already answered", () => {
    t = makeTestDb();
    expect(() => decideProposal(t.db, 999, "accept", NOW)).toThrow(DeskError);
    const p = open({ kind: "prediction_due", payload: { predictionId: 1 } });
    decideProposal(t.db, p.id, "dismiss", NOW);
    expect(() => decideProposal(t.db, p.id, "accept", NOW)).toThrow(/already been answered/);
  });

  it("snoozes for the configured days and says when it is back", () => {
    t = makeTestDb();
    const p = open({ kind: "prediction_due", payload: { predictionId: 1 } });
    const out = decideProposal(t.db, p.id, "snooze", NOW);
    expect(out.label).toBe("Back in 7 days");
    expect(state(p.id)).toMatchObject({ state: "snoozed", snoozedUntil: "2026-11-15T09:00:00.000Z" });
  });

  /** "Never" writes nothing but the row: the downweighting is `dismissRate` reading it later,
   * which is why undoing a dismissal takes the lesson with it. */
  it("dismisses without touching anything else", () => {
    t = makeTestDb();
    const p = open({ kind: "prediction_due", payload: { predictionId: 1 } });
    expect(decideProposal(t.db, p.id, "dismiss", NOW).label).toBe("Won't ask again");
    expect(state(p.id)).toMatchObject({ state: "dismissed", decidedAt: NOW.toISOString() });
  });

  describe("meeting_unprepared", () => {
    it("starts a prep note carrying the facts, and undoing deletes it", () => {
      t = makeTestDb();
      const p = open({
        kind: "meeting_unprepared",
        payload: { eventId: 1, title: "Design review", startsAt: "2026-11-08T10:30:00.000Z", containerId: null, attendeeNames: ["Priya", "Sam"], organizer: "priya@example.com" },
      });
      const out = decideProposal(t.db, p.id, "accept", NOW);
      expect(out.label).toBe("Started a prep note for Design review");

      const note = listItems(t.db, { type: "note" })[0];
      expect(note.title).toBe("Prep: Design review");
      expect(note.body).toContain("With: Priya, Sam");
      expect(note.body).toContain("Called by: priya@example.com");
      expect(out.href).toBe(`/items/${note.id}`);

      undoProposal(t.db, p.id);
      expect(getItem(t.db, note.id)).toBeUndefined();
      expect(state(p.id).state).toBe("open");
    });
  });

  describe("decision_stale", () => {
    it("stamps the decision as checked now, and undoing puts the old stamp back", () => {
      t = makeTestDb();
      t.db.insert(meetingSeriesDecisions).values({ seriesId: "s1", decision: "not-going", decidedAt: "2026-01-01T00:00:00.000Z", lastVerified: "2026-02-01T00:00:00.000Z" }).run();
      const p = open({ kind: "decision_stale", payload: { seriesId: "s1" } });

      expect(decideProposal(t.db, p.id, "accept", NOW).label).toBe("Reaffirmed");
      const after = t.db.select().from(meetingSeriesDecisions).where(eq(meetingSeriesDecisions.seriesId, "s1")).get()!;
      expect(after).toMatchObject({ lastVerified: NOW.toISOString(), confidence: 1, decision: "not-going" });

      undoProposal(t.db, p.id);
      expect(t.db.select().from(meetingSeriesDecisions).where(eq(meetingSeriesDecisions.seriesId, "s1")).get()).toMatchObject({
        lastVerified: "2026-02-01T00:00:00.000Z",
        confidence: null,
      });
    });

    /** Nothing is ever deleted on the app's own initiative: reaffirming keeps the decision, and
     * the row survives either answer. */
    it("never removes the decision, whichever way it is answered", () => {
      t = makeTestDb();
      t.db.insert(meetingSeriesDecisions).values({ seriesId: "s1", decision: "going", decidedAt: "2026-01-01T00:00:00.000Z" }).run();
      const p = open({ kind: "decision_stale", payload: { seriesId: "s1" } });
      decideProposal(t.db, p.id, "dismiss", NOW);
      expect(t.db.select().from(meetingSeriesDecisions).all()).toHaveLength(1);
    });

    it("refuses when the decision has gone, and leaves the card open", () => {
      t = makeTestDb();
      const p = open({ kind: "decision_stale", payload: { seriesId: "gone" } });
      expect(() => decideProposal(t.db, p.id, "accept", NOW)).toThrow(/no longer there/);
      expect(state(p.id).state).toBe("open");
    });
  });

  describe("task_overrun", () => {
    it("re-estimates to the proposed minutes, naming them, and undoing restores the old estimate", () => {
      t = makeTestDb();
      const task = t.db.insert(tasks).values({ title: "Write the migration", estimateMinutes: 60, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
      const p = open({ kind: "task_overrun", payload: { taskId: task.id, proposedMinutes: 90 } });

      expect(decideProposal(t.db, p.id, "accept", NOW).label).toBe("Re-estimated to 1h 30m");
      expect(getTask(t.db, task.id)!.estimateMinutes).toBe(90);

      undoProposal(t.db, p.id);
      expect(getTask(t.db, task.id)!.estimateMinutes).toBe(60);
    });
  });

  describe("task_stalled", () => {
    it("takes the task off today and every day planned after it, leaving the past alone", () => {
      t = makeTestDb();
      const task = t.db.insert(tasks).values({ title: "Answer the auditors", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
      for (const date of ["2026-11-05", "2026-11-08", "2026-11-09"]) {
        t.db.insert(dailyPlanEntries).values({ date, taskId: task.id, createdAt: NOW.toISOString() }).run();
      }
      const p = open({ kind: "task_stalled", payload: { taskId: task.id } });

      expect(decideProposal(t.db, p.id, "accept", NOW).label).toBe("Taken off 2 days' plans");
      expect(listPlan(t.db, "2026-11-08")).toHaveLength(0);
      expect(listPlan(t.db, "2026-11-09")).toHaveLength(0);
      // Yesterday is a record of what was intended; editing it rewrites the past.
      expect(listPlan(t.db, "2026-11-05")).toHaveLength(1);

      undoProposal(t.db, p.id);
      expect(listPlan(t.db, "2026-11-08")).toHaveLength(1);
      expect(listPlan(t.db, "2026-11-09")).toHaveLength(1);
    });

    it("leaves the task itself open: it is the plan being dropped, not the work", () => {
      t = makeTestDb();
      const task = t.db.insert(tasks).values({ title: "Answer the auditors", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
      t.db.insert(dailyPlanEntries).values({ date: "2026-11-08", taskId: task.id, createdAt: NOW.toISOString() }).run();
      const p = open({ kind: "task_stalled", payload: { taskId: task.id } });
      decideProposal(t.db, p.id, "accept", NOW);
      expect(getTask(t.db, task.id)!.status).toBe("open");
    });
  });


  describe("commitment_owed", () => {
    it("puts it on today's plan, naming the person, and undoing takes it off again", () => {
      t = makeTestDb();
      const task = t.db.insert(tasks).values({ title: "Review the migration plan", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
      const p = open({ kind: "commitment_owed", payload: { taskId: task.id, personName: "Priya Raman" } });

      const decided = decideProposal(t.db, p.id, "accept", NOW);
      expect(decided.label).toBe("Planned for today for Priya Raman");
      expect(decided.href).toBe("/planner");
      expect(listPlan(t.db, "2026-11-08")).toHaveLength(1);
      // The work itself is untouched: planning it is not doing it.
      expect(getTask(t.db, task.id)!.status).toBe("open");

      undoProposal(t.db, p.id);
      expect(listPlan(t.db, "2026-11-08")).toHaveLength(0);
    });

    it("says so rather than failing when today already holds it, and the undo keeps it there", () => {
      t = makeTestDb();
      const task = t.db.insert(tasks).values({ title: "Review the migration plan", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
      t.db.insert(dailyPlanEntries).values({ date: "2026-11-08", taskId: task.id, createdAt: NOW.toISOString() }).run();
      const p = open({ kind: "commitment_owed", payload: { taskId: task.id, personName: "Priya Raman" } });

      expect(decideProposal(t.db, p.id, "accept", NOW).label).toBe("Already on today's plan");
      undoProposal(t.db, p.id);
      // The undo reverses what the decision did, and it did nothing.
      expect(listPlan(t.db, "2026-11-08")).toHaveLength(1);
    });

    it("refuses a task that has since been deleted", () => {
      t = makeTestDb();
      const p = open({ kind: "commitment_owed", payload: { taskId: 404, personName: "Priya Raman" } });
      expect(() => decideProposal(t.db, p.id, "accept", NOW)).toThrow(/no longer there/);
    });
  });
  describe("prediction_due", () => {
    it("commits nothing and sends you where the answer can be given", () => {
      t = makeTestDb();
      const pred = t.db
        .insert(predictions)
        .values({ kind: "estimate", claim: "Under a day", resolveBy: "2026-11-01", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })
        .returning()
        .get();
      const p = open({ kind: "prediction_due", payload: { predictionId: pred.id } });
      const out = decideProposal(t.db, p.id, "accept", NOW);
      expect(out.href).toBe(`/log?resolve=${pred.id}`);
      expect(t.db.select().from(predictions).get()!.resolvedAt).toBeNull();
    });
  });

  describe("capture_unfiled", () => {
    it("files the capture where the card said, and undoing unfiles it", () => {
      t = makeTestDb();
      const c = t.db.insert(containers).values({ kind: "project", name: "Migrations", slug: "migrations", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
      const note = t.db.insert(items).values({ type: "note", title: "Migration notes", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }).returning().get();
      const p = open({ kind: "capture_unfiled", payload: { itemId: note.id, containerId: c.id, containerName: "Migrations" } });

      expect(decideProposal(t.db, p.id, "accept", NOW).label).toBe("Filed in Migrations");
      expect(getItem(t.db, note.id)!.containerId).toBe(c.id);

      undoProposal(t.db, p.id);
      expect(getItem(t.db, note.id)!.containerId).toBeNull();
    });
  });

  describe("commitment_unbooked", () => {
    function meetingWithAction() {
      return t.db
        .insert(items)
        .values({
          type: "meeting",
          title: "Platform weekly",
          meta: JSON.stringify({ summary: { proposed_actions: [{ title: "Send the plan", notes: "by Friday" }] } }),
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        })
        .returning()
        .get();
    }

    it("books the action as a task that remembers the meeting, and undoing removes it", () => {
      t = makeTestDb();
      const meeting = meetingWithAction();
      const p = open({ kind: "commitment_unbooked", payload: { itemId: meeting.id, index: 0, title: "Send the plan" } });

      expect(decideProposal(t.db, p.id, "accept", NOW).label).toBe('Booked "Send the plan"');
      const [task] = listTasks(t.db, { sourceItemId: meeting.id, status: "all" });
      expect(task).toMatchObject({ title: "Send the plan", notes: "by Friday" });
      expect(getItem(t.db, meeting.id)!.meta).toContain("acceptedActions");

      undoProposal(t.db, p.id);
      expect(listTasks(t.db, { sourceItemId: meeting.id, status: "all" })).toHaveLength(0);
      expect(JSON.parse(getItem(t.db, meeting.id)!.meta).acceptedActions).toEqual([]);
    });

    /** The desk and the meeting page share one piece of bookkeeping, so the desk's undo must not
     * destroy a task the meeting page booked. */
    it("undoing leaves alone a task that was already booked elsewhere", () => {
      t = makeTestDb();
      const meeting = meetingWithAction();
      const p = open({ kind: "commitment_unbooked", payload: { itemId: meeting.id, index: 0, title: "Send the plan" } });
      // Booked from the meeting page first.
      acceptMeetingAction(t.db, meeting.id, 0);

      decideProposal(t.db, p.id, "accept", NOW);
      undoProposal(t.db, p.id);

      expect(listTasks(t.db, { sourceItemId: meeting.id, status: "all" })).toHaveLength(1);
      expect(JSON.parse(getItem(t.db, meeting.id)!.meta).acceptedActions).toEqual([0]);
    });
  });
});

describe("undoProposal", () => {
  it("is silent about a proposal that was never accepted, or whose offer has gone", () => {
    t = makeTestDb();
    const p = open({ kind: "prediction_due", payload: { predictionId: 1 } });
    expect(undoProposal(t.db, p.id)).toBeNull();

    decideProposal(t.db, p.id, "accept", NOW);
    resetUndos();
    expect(undoProposal(t.db, p.id)).toBeNull();
    expect(state(p.id).state).toBe("accepted");
  });

  it("puts an undone proposal back on the desk as if it had never been answered", () => {
    t = makeTestDb();
    const p = open({ kind: "prediction_due", payload: { predictionId: 1 } });
    decideProposal(t.db, p.id, "accept", NOW);
    undoProposal(t.db, p.id);
    expect(state(p.id)).toMatchObject({ state: "open", decidedAt: null });
  });
});

describe("ask_unanswered", () => {
  /** An observation plus the open proposal the generator would have made for it. */
  function anAsk(over: Record<string, unknown> = {}) {
    ingestObservations(
      t.db,
      [
        {
          source: "slack",
          externalId: "T1/C1/1731600000.000100",
          at: "2026-10-20T09:00:00.000Z",
          kind: "mention",
          actorHandle: "priya",
          actorName: "Priya Raman",
          text: "can you confirm the Q4 numbers?",
          url: "https://app.slack.com/client/T1/C1/p1",
          context: "#project-atlas",
          ...over,
        },
      ],
      NOW,
    );
    const row = t.db.select().from(observations).all()[0];
    return {
      row,
      proposal: open({
        kind: "ask_unanswered",
        source: "observation",
        sourceRef: `observation:${row.id}`,
        payload: {
          observationId: row.id,
          actorHandle: row.actorHandle,
          actorName: row.actorName,
          askedAt: row.at,
          url: row.url,
          title: "can you confirm the Q4 numbers?",
        },
      }),
    };
  }

  it("turns an ask into a commitment owed to the person who asked", () => {
    t = makeTestDb();
    const { row, proposal } = anAsk();
    const decided = decideProposal(t.db, proposal.id, "accept", NOW);
    expect(decided.label).toBe("Now owed to Priya Raman");
    const task = listTasks(t.db, { status: "open" }).find((x) => x.title === "can you confirm the Q4 numbers?")!;
    expect(task.requesterPersonId).not.toBeNull();
    // The wait is dated from the message, not from the moment the card was answered -- three
    // weeks of somebody waiting must not be reset to nothing by finally noticing.
    expect(task.askedOn).toBe("2026-10-20");
    expect(t.db.select().from(observations).where(eq(observations.id, row.id)).get()!.taskId).toBe(task.id);
  });

  it("reuses a person already known by name rather than inventing a second one", () => {
    t = makeTestDb();
    const existing = createPerson(t.db, { name: "Priya Raman" });
    const { proposal } = anAsk();
    decideProposal(t.db, proposal.id, "accept", NOW);
    expect(listPeople(t.db)).toHaveLength(1);
    const task = listTasks(t.db, { status: "open" })[0];
    expect(task.requesterPersonId).toBe(existing.id);
  });

  it("undo removes the task, the link and the person it invented", () => {
    t = makeTestDb();
    const { row, proposal } = anAsk();
    decideProposal(t.db, proposal.id, "accept", NOW);
    undoProposal(t.db, proposal.id);
    expect(listTasks(t.db, { status: "open" })).toHaveLength(0);
    expect(t.db.select().from(observations).where(eq(observations.id, row.id)).get()!.taskId).toBeNull();
    expect(listPeople(t.db)).toHaveLength(0);
  });

  it("undo leaves a person who was already known", () => {
    t = makeTestDb();
    createPerson(t.db, { name: "Priya Raman" });
    const { proposal } = anAsk();
    decideProposal(t.db, proposal.id, "accept", NOW);
    undoProposal(t.db, proposal.id);
    expect(listPeople(t.db)).toHaveLength(1);
  });

  it("refuses an ask that is already a task", () => {
    t = makeTestDb();
    const { proposal } = anAsk();
    decideProposal(t.db, proposal.id, "accept", NOW);
    const second = open({
      kind: "ask_unanswered",
      source: "observation",
      sourceRef: "observation:999",
      payload: { observationId: t.db.select().from(observations).all()[0].id, actorName: "Priya Raman", actorHandle: "priya", askedAt: NOW.toISOString(), title: "again" },
    });
    expect(() => decideProposal(t.db, second.id, "accept", NOW)).toThrow(/already a task/);
  });
});
