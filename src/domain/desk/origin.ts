import type { DB } from "@/db/client";
import type { ProposalKind } from "@/db/enums";
import { getContainer } from "@/domain/containers";
import { getTask } from "@/domain/tasks";

/**
 * What a card is *about*, and where to go and look at it.
 *
 * The desk used to show a sentence and nothing else, which asked you to take its word for it. A
 * decision you cannot check is a decision you defer, and deferring is what the desk has done for
 * its whole existence. The label names the thing in your world -- the project, the person, the
 * channel -- and the link, where there is one, opens it.
 *
 * Resolved on the server because that is where the slugs are: the payload carries ids, and
 * `/c/[slug]` and `/people/[slug]` want names.
 */
export interface Origin {
  label: string;
  href: string | null;
}

function container(db: DB, id: unknown): Origin | null {
  if (typeof id !== "number") return null;
  const row = getContainer(db, id);
  return row ? { label: row.name, href: `/c/${row.slug}` } : null;
}

/** The container a task belongs to, for the kinds whose payload carries only the task. */
function taskContainer(db: DB, id: unknown): Origin | null {
  if (typeof id !== "number") return null;
  const task = getTask(db, id);
  return task ? container(db, task.containerId) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * A Slack permalink is an `https://` URL, and following one navigates whatever is showing it --
 * in the desktop shell that is the app's own window, which is how clicking a row turned Second
 * Brain into a Slack browser. `slack://` is the scheme macOS routes to the installed app, where
 * the message already is and where answering it is possible.
 *
 * Both shapes the reader produces are handled: an Activity row's rebuilt
 * `app.slack.com/client/<team>/<channel>/p<ts>` and a channel row's own
 * `<workspace>.slack.com/archives/<channel>/p<ts>`, which carries no team id. Slack resolves a
 * message without one; anything unrecognised is handed back untouched rather than mangled.
 */
const PERMALINK = /^https:\/\/(?:app\.slack\.com\/client\/(T[A-Z0-9]+)|[a-z0-9-]+\.slack\.com)\/(?:archives\/)?([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})/i;

export function slackAppLink(url: string | null): string | null {
  if (url === null) return null;
  const m = PERMALINK.exec(url);
  if (!m) return url;
  const [, team, channel, seconds, micro] = m;
  const query = new URLSearchParams({ id: channel, message: `${seconds}.${micro}` });
  if (team) query.set("team", team);
  return `slack://channel?${query}`;
}

/**
 * One switch, per kind, because only the kind knows which of its payload keys names the thing.
 * A kind with nothing worth linking to returns a label and a null href rather than a dead link.
 */
export function originOf(db: DB, kind: ProposalKind, payload: Record<string, unknown>): Origin | null {
  switch (kind) {
    case "task_overdue":
      // Grouped cards carry the container directly; a lone task has to be looked up through it.
      return container(db, payload.containerId) ?? taskContainer(db, payload.taskId);

    case "task_stalled":
    case "task_overrun":
      return taskContainer(db, payload.taskId);

    case "commitment_owed": {
      const slug = str(payload.personSlug);
      const name = str(payload.personName);
      if (!name) return null;
      return { label: name, href: slug ? `/people/${slug}` : null };
    }

    case "ask_unanswered": {
      // The permalink back into Slack, which is the only place the message itself exists.
      const label = str(payload.context) ?? str(payload.actorName) ?? "Slack";
      return { label, href: slackAppLink(str(payload.url)) };
    }

    case "reply_awaited": {
      // Where I said it, which is where I would go to say it again.
      const label = str(payload.context) ?? "Slack";
      return { label, href: slackAppLink(str(payload.url)) };
    }

    case "capture_unfiled": {
      const id = payload.itemId;
      return typeof id === "number" ? { label: "Inbox", href: `/items/${id}` } : null;
    }

    case "commitment_unbooked": {
      const id = payload.itemId;
      const label = str(payload.meetingTitle) ?? "A meeting";
      return { label, href: typeof id === "number" ? `/items/${id}` : null };
    }

    case "prediction_due":
      return { label: "Log", href: "/log" };

    case "meeting_unprepared":
      return { label: str(payload.title) ?? "A meeting", href: "/planner/meetings" };

    case "decision_stale":
      // A meeting series has no page of its own yet, so this names the thing without pretending
      // there is somewhere to go.
      return { label: str(payload.title) ?? "A standing decision", href: null };

    default:
      return null;
  }
}
