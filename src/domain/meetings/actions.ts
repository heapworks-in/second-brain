import type { DB } from "@/db/client";
import { getItem, parseMeta, updateItem } from "@/domain/items";
import { createTask, listTasks } from "@/domain/tasks";
import type { Item, Task } from "@/db/schema";
import { MeetingError } from "./errors";

/** The parts of a meeting item's `meta` that booking an action reads and writes. */
export interface MeetingActionsMeta {
  summary?: { proposed_actions?: { title?: unknown; notes?: unknown }[] };
  acceptedActions?: number[];
}

export function proposedAction(item: Item, index: number): { title: string; notes: string } | undefined {
  const meta = parseMeta<MeetingActionsMeta>(item);
  const raw = meta.summary?.proposed_actions;
  const action = Array.isArray(raw) ? raw[index] : undefined;
  if (!action) return undefined;
  return { title: typeof action.title === "string" ? action.title : "", notes: typeof action.notes === "string" ? action.notes : "" };
}

/**
 * Turn one proposed action into a task, and record that it has been turned.
 *
 * Shared by the meeting page's own accept button and the desk's `commitment_unbooked` card,
 * because the index bookkeeping is the only thing stopping the two from booking the same action
 * twice — and a second copy of it would be a second opinion about what has already been done.
 *
 * Idempotent on the index: a second call answers with the task the first one made, so a retry,
 * a stale tab and a double press all cost one task. `created` is false in that case, which is
 * how the route knows to answer 200 rather than 201.
 */
export function acceptMeetingAction(db: DB, itemId: number, index: number, title?: string): { task: Task; created: boolean } {
  const item = getItem(db, itemId);
  if (!item) throw new MeetingError(`Meeting ${itemId} not found`, 404);
  if (item.type !== "meeting") throw new MeetingError("Only a meeting proposes actions", 400);

  const action = proposedAction(item, index);
  if (!action) throw new MeetingError(`Meeting ${itemId} has no proposed action ${index}`, 404);

  // The person is allowed to reword what the model proposed; absent a rewording, the model's own
  // title stands.
  const wanted = (title ?? action.title).trim();
  if (!wanted) throw new MeetingError(`Proposed action ${index} has no title`, 400);

  const meta = parseMeta<MeetingActionsMeta>(item);
  if (meta.acceptedActions?.includes(index)) {
    const made = listTasks(db, { sourceItemId: item.id, status: "all" });
    const existing = made.find((t) => t.title === wanted || t.title === action.title) ?? made.reduce<Task | undefined>((a, b) => (a && a.id > b.id ? a : b), undefined);
    if (existing) return { task: existing, created: false };
  }

  const task = createTask(db, { title: wanted, notes: action.notes, containerId: item.containerId, sourceItemId: item.id });
  markActionAccepted(db, itemId, index, true);
  return { task, created: true };
}

/** Add or remove one index from a meeting's accepted set. The desk's undo needs the removal. */
export function markActionAccepted(db: DB, itemId: number, index: number, accepted: boolean): void {
  const item = getItem(db, itemId);
  if (!item) return;
  const meta = parseMeta<MeetingActionsMeta>(item);
  const current = new Set(meta.acceptedActions ?? []);
  if (accepted) current.add(index);
  else current.delete(index);
  updateItem(db, itemId, { meta: { ...meta, acceptedActions: [...current].sort((a, b) => a - b) } as Record<string, unknown> });
}
