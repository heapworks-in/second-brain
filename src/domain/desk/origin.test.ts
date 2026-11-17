import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { containers, tasks } from "@/db/schema";
import { originOf, slackAppLink } from "./origin";

let t: TestDb;
afterEach(() => t?.cleanup());

const ISO = "2026-11-15T12:00:00.000Z";

function container(name = "Atlas", slug = "atlas") {
  return t.db.insert(containers).values({ kind: "project", name, slug, createdAt: ISO, updatedAt: ISO }).returning().get();
}

function task(containerId: number | null) {
  return t.db.insert(tasks).values({ title: "A task", containerId, createdAt: ISO, updatedAt: ISO }).returning().get();
}

describe("originOf", () => {
  it("takes a grouped overdue card's container straight from the payload", () => {
    t = makeTestDb();
    const c = container();
    expect(originOf(t.db, "task_overdue", { containerId: c.id })).toEqual({ label: "Atlas", href: "/c/atlas" });
  });

  it("looks a lone task's container up through the task", () => {
    t = makeTestDb();
    const c = container();
    expect(originOf(t.db, "task_overdue", { taskId: task(c.id).id })).toEqual({ label: "Atlas", href: "/c/atlas" });
  });

  it("says nothing rather than guessing when a task belongs nowhere", () => {
    t = makeTestDb();
    expect(originOf(t.db, "task_stalled", { taskId: task(null).id })).toBeNull();
  });

  it("survives a payload pointing at something that has been deleted", () => {
    // Payloads outlive their rows on purpose -- sourceRef is a string, not a foreign key -- so a
    // dangling id must give no link rather than a crash or a 404 waiting to be clicked.
    t = makeTestDb();
    expect(originOf(t.db, "task_overdue", { containerId: 404 })).toBeNull();
    expect(originOf(t.db, "task_overrun", { taskId: 404 })).toBeNull();
  });

  it("survives a payload missing the key it expects", () => {
    t = makeTestDb();
    expect(originOf(t.db, "task_overdue", {})).toBeNull();
    expect(originOf(t.db, "commitment_owed", {})).toBeNull();
    expect(originOf(t.db, "capture_unfiled", {})).toBeNull();
  });

  it("points a commitment at the person waiting, and names them without a link if it must", () => {
    t = makeTestDb();
    expect(originOf(t.db, "commitment_owed", { personName: "Priya Raman", personSlug: "priya" })).toEqual({
      label: "Priya Raman",
      href: "/people/priya",
    });
    expect(originOf(t.db, "commitment_owed", { personName: "Priya Raman" })).toEqual({ label: "Priya Raman", href: null });
  });

  it("points a Slack ask back at the message, which is the only place it exists", () => {
    t = makeTestDb();
    expect(
      originOf(t.db, "ask_unanswered", { context: "#project-atlas", url: "https://app.slack.com/client/T1/C1/p1" }),
    ).toEqual({ label: "#project-atlas", href: "https://app.slack.com/client/T1/C1/p1" });
  });

  it("sends a Slack ask to the Slack app, not to a browser inside this one", () => {
    // An https permalink navigates whatever window is showing it -- in the desktop shell, this
    // app's own. The deep link is what macOS hands to the installed Slack.
    t = makeTestDb();
    expect(
      originOf(t.db, "ask_unanswered", {
        context: "#project-atlas",
        url: "https://app.slack.com/client/T0H7I8J9K/C0A1B2C3D/p1794429455856259",
      }),
    ).toEqual({ label: "#project-atlas", href: "slack://channel?id=C0A1B2C3D&message=1794429455.856259&team=T0H7I8J9K" });
  });

  it("falls back to who asked when Slack gave no channel", () => {
    t = makeTestDb();
    expect(originOf(t.db, "ask_unanswered", { actorName: "Priya Raman" })).toEqual({ label: "Priya Raman", href: null });
    expect(originOf(t.db, "ask_unanswered", {})).toEqual({ label: "Slack", href: null });
  });

  it("sends a question of mine to the same place, the channel I asked in", () => {
    t = makeTestDb();
    expect(
      originOf(t.db, "reply_awaited", {
        context: "#project-atlas",
        url: "https://app.slack.com/client/T0H7I8J9K/C0A1B2C3D/p1794429455856259",
      }),
    ).toEqual({ label: "#project-atlas", href: "slack://channel?id=C0A1B2C3D&message=1794429455.856259&team=T0H7I8J9K" });
    // No actor to fall back on: the actor is me, and "Avinash" is not a useful label on my own
    // board.
    expect(originOf(t.db, "reply_awaited", {})).toEqual({ label: "Slack", href: null });
  });

  it("opens the captured item itself for an unfiled capture", () => {
    t = makeTestDb();
    expect(originOf(t.db, "capture_unfiled", { itemId: 7 })).toEqual({ label: "Inbox", href: "/items/7" });
  });

  it("names the meeting an unbooked commitment came out of", () => {
    t = makeTestDb();
    expect(originOf(t.db, "commitment_unbooked", { itemId: 7, meetingTitle: "Weekly sync" })).toEqual({
      label: "Weekly sync",
      href: "/items/7",
    });
    expect(originOf(t.db, "commitment_unbooked", { itemId: 7 })).toEqual({ label: "A meeting", href: "/items/7" });
  });

  it("sends a due prediction to the log", () => {
    t = makeTestDb();
    expect(originOf(t.db, "prediction_due", { predictionId: 3 })).toEqual({ label: "Log", href: "/log" });
  });

  it("names a standing decision without pretending there is a page for it", () => {
    // A meeting series has no route yet. A label with a null href is honest; a link to nowhere
    // is the thing that teaches you to stop clicking them.
    t = makeTestDb();
    expect(originOf(t.db, "decision_stale", { title: "Deploy on Thursdays" })).toEqual({
      label: "Deploy on Thursdays",
      href: null,
    });
  });

  it("sends an unprepared meeting to the meetings view", () => {
    t = makeTestDb();
    expect(originOf(t.db, "meeting_unprepared", { title: "Weekly sync" })).toEqual({
      label: "Weekly sync",
      href: "/planner/meetings",
    });
  });

  it("ignores a payload value of the wrong type instead of rendering it", () => {
    t = makeTestDb();
    expect(originOf(t.db, "task_overdue", { containerId: "not-a-number" })).toBeNull();
    expect(originOf(t.db, "commitment_owed", { personName: "   " })).toBeNull();
  });
});

describe("slackAppLink", () => {
  it("rebuilds the timestamp a permalink flattened", () => {
    // `p1794429455856259` is one run of digits; Slack wants `1794429455.856259` back.
    expect(slackAppLink("https://app.slack.com/client/T0H7I8J9K/C0A1B2C3D/p1794429455856259")).toBe(
      "slack://channel?id=C0A1B2C3D&message=1794429455.856259&team=T0H7I8J9K",
    );
  });

  it("handles a channel row's archives link, which carries no team", () => {
    expect(slackAppLink("https://acme.slack.com/archives/C0A1B2C3D/p1794429455856259")).toBe(
      "slack://channel?id=C0A1B2C3D&message=1794429455.856259",
    );
  });

  it("hands back anything it does not recognise rather than mangling it", () => {
    // A url from an adaptor this file has never seen must still open, just not as Slack.
    expect(slackAppLink("https://example.com/thread/9")).toBe("https://example.com/thread/9");
    expect(slackAppLink("https://app.slack.com/client/T0H7I8J9K/activity-inbox")).toBe(
      "https://app.slack.com/client/T0H7I8J9K/activity-inbox",
    );
    expect(slackAppLink(null)).toBeNull();
  });
});
