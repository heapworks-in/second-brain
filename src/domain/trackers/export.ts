import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { containers, people, tasks, trackers, type Tracker } from "@/db/schema";
import { getSetting } from "@/domain/settings";
import type { TrackerRowDTO } from "@/lib/dto";
import { ID_HEADER, TRACKER_FIELDS, type Mapping } from "./mapping";
import { TrackerError } from "./import";

/** The name to write in the owner column for my own rows: the first spelling of my own name the
 * identity setting holds, so the file reads the way the team already reads it. */
export function myName(db: DB): string {
  const first = getSetting(db, "identity.names", "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)[0];
  return first ?? "Me";
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function trackerMapping(tracker: Tracker): Mapping {
  const mapping = parse<Partial<Mapping>>(tracker.mapping, {});
  return { columns: mapping.columns ?? {}, theme: mapping.theme === "container" ? "container" : "group" };
}

/**
 * The tracker as a sheet, ready to write.
 *
 * Column order is the file's own, which is why `headers` was stored at import: a tracker given
 * back with its columns rearranged is a tracker somebody has to fix by hand before sending it
 * on. `SB ID` is appended if the file did not have it, and that column is what makes the next
 * re-import an exact match rather than a guess.
 */
export function trackerSheet(db: DB, trackerId: number): { name: string; headers: string[]; rows: Record<string, string>[] } {
  const tracker = db.select().from(trackers).where(eq(trackers.id, trackerId)).get();
  if (!tracker) throw new TrackerError(`Tracker ${trackerId} not found`, 404);
  const mapping = trackerMapping(tracker);
  const columns = mapping.columns;
  const stored = parse<string[]>(tracker.headers, []);
  const headers = stored.includes(ID_HEADER) ? stored : [...stored, ID_HEADER];

  const rows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      parentLabel: tasks.parentLabel,
      theme: tasks.theme,
      notes: tasks.notes,
      dueDate: tasks.dueDate,
      status: tasks.status,
      statusLabel: tasks.statusLabel,
      sheetExtra: tasks.sheetExtra,
      sheetRow: tasks.sheetRow,
      ownerName: people.name,
      team: people.team,
      containerName: containers.name,
    })
    .from(tasks)
    .leftJoin(people, eq(people.id, tasks.ownerPersonId))
    .leftJoin(containers, eq(containers.id, tasks.containerId))
    .where(eq(tasks.trackerId, trackerId))
    // The file's own order first; a row added here since has no place in it and follows.
    .orderBy(sql`${tasks.sheetRow} is null`, asc(tasks.sheetRow), asc(tasks.id))
    .all();

  const mine = myName(db);
  const out = rows.map((row) => {
    const record: Record<string, string> = { ...parse<Record<string, string>>(row.sheetExtra, {}) };
    const put = (field: (typeof TRACKER_FIELDS)[number], value: string) => {
      const header = columns[field];
      if (header) record[header] = value;
    };
    put("theme", mapping.theme === "container" ? (row.containerName ?? "") : row.theme);
    put("task", row.parentLabel || row.title);
    put("subTask", row.parentLabel ? row.title : "");
    put("owner", row.ownerName ?? mine);
    // Only when there is one: a row of mine keeps its own team cell in `sheetExtra`, which the
    // spread above has already put back, and writing an empty string here would wipe it.
    if (row.team) put("team", row.team);
    put("comments", row.notes);
    // A date that is known is written as a date; one that was always prose keeps the words the
    // file already had, which `sheetExtra` is still holding under this very header.
    if (row.dueDate) put("eta", row.dueDate);
    put("status", row.statusLabel || (row.status === "done" ? "Done" : row.status === "dropped" ? "Dropped" : "Not started"));
    record[ID_HEADER] = String(row.id);
    return record;
  });

  return { name: tracker.sheetName || tracker.name, headers, rows: out };
}

/**
 * The tracker's rows for its own page, in the file's order.
 *
 * Returns the sheet's shape rather than the task's: a theme, a parent label, who owns it and the
 * word the team reads. The page is a view of somebody's spreadsheet, so it reads like one.
 */
export function trackerRows(db: DB, trackerId: number): TrackerRowDTO[] {
  const mapping = trackerMapping(getTracker(db, trackerId) ?? ({ mapping: "{}" } as Tracker));
  const etaHeader = mapping.columns.eta;
  return db
    .select({
      id: tasks.id,
      theme: tasks.theme,
      parentLabel: tasks.parentLabel,
      title: tasks.title,
      ownerPersonId: tasks.ownerPersonId,
      ownerName: people.name,
      ownerSlug: people.slug,
      dueDate: tasks.dueDate,
      status: tasks.status,
      statusLabel: tasks.statusLabel,
      notes: tasks.notes,
      sheetExtra: tasks.sheetExtra,
      sheetRow: tasks.sheetRow,
      containerName: containers.name,
    })
    .from(tasks)
    .leftJoin(people, eq(people.id, tasks.ownerPersonId))
    .leftJoin(containers, eq(containers.id, tasks.containerId))
    .where(eq(tasks.trackerId, trackerId))
    .orderBy(sql`${tasks.sheetRow} is null`, asc(tasks.sheetRow), asc(tasks.id))
    .all()
    .map((row) => ({
      id: row.id,
      theme: mapping.theme === "container" ? (row.containerName ?? "") : row.theme,
      parentLabel: row.parentLabel,
      title: row.title,
      owner: row.ownerPersonId === null || !row.ownerName ? null : { id: row.ownerPersonId, name: row.ownerName, slug: row.ownerSlug ?? "" },
      dueDate: row.dueDate,
      etaText: row.dueDate || !etaHeader ? "" : (parse<Record<string, string>>(row.sheetExtra, {})[etaHeader] ?? ""),
      status: row.status,
      statusLabel: row.statusLabel,
      notes: row.notes,
      mine: row.ownerPersonId === null,
    }));
}

/** What a tracker's own page needs to know about it without reading every row twice. */
export function trackerCounts(db: DB, trackerId: number): { rows: number; open: number; mine: number; done: number } {
  const row = db
    .select({
      rows: sql<number>`count(*)`,
      open: sql<number>`sum(case when ${tasks.status} = 'open' then 1 else 0 end)`,
      done: sql<number>`sum(case when ${tasks.status} = 'done' then 1 else 0 end)`,
      mine: sql<number>`sum(case when ${tasks.ownerPersonId} is null then 1 else 0 end)`,
    })
    .from(tasks)
    .where(eq(tasks.trackerId, trackerId))
    .get();
  return { rows: Number(row?.rows ?? 0), open: Number(row?.open ?? 0), done: Number(row?.done ?? 0), mine: Number(row?.mine ?? 0) };
}

/** Every tracker, newest import first, each with what it holds. */
export function listTrackers(db: DB): (Tracker & { counts: ReturnType<typeof trackerCounts> })[] {
  return db
    .select()
    .from(trackers)
    .orderBy(sql`${trackers.updatedAt} desc`)
    .all()
    .map((t) => ({ ...t, counts: trackerCounts(db, t.id) }));
}

export function getTrackerBySlug(db: DB, slug: string): Tracker | undefined {
  return db.select().from(trackers).where(eq(trackers.slug, slug)).get();
}

export function getTracker(db: DB, id: number): Tracker | undefined {
  return db.select().from(trackers).where(eq(trackers.id, id)).get();
}

/**
 * Remove a tracker, with or without the rows it brought.
 *
 * Both are real answers and the page says which is which: "keep the rows" leaves them as
 * ordinary tasks, which is what you want when the sheet was only ever how the work arrived;
 * "delete them too" is for a file imported by mistake. Rows of mine are never deleted silently
 * -- the count the caller shows includes them, and `rows: "delete"` is the explicit yes.
 */
export function deleteTracker(db: DB, id: number, rows: "keep" | "delete"): { deletedRows: number } {
  if (!getTracker(db, id)) throw new TrackerError(`Tracker ${id} not found`, 404);
  let deletedRows = 0;
  db.transaction((tx) => {
    if (rows === "delete") {
      deletedRows = tx.delete(tasks).where(eq(tasks.trackerId, id)).run().changes;
    } else {
      // The sheet's own columns go with the sheet: a row kept as a task should not carry a
      // theme, a parent label and a stash of spreadsheet cells nothing will ever write back.
      tx.update(tasks)
        .set({ trackerId: null, theme: "", parentLabel: "", sheetExtra: "{}", sheetRow: null })
        .where(eq(tasks.trackerId, id))
        .run();
    }
    tx.delete(trackers).where(eq(trackers.id, id)).run();
  });
  return { deletedRows };
}

/** Rows of a tracker that are mine and still open -- what the tracker page leads with, because
 * it is the only part of somebody else's sheet I can actually act on. */
export function myOpenRows(db: DB, trackerId: number): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.trackerId, trackerId), isNull(tasks.ownerPersonId), eq(tasks.status, "open")))
    .get();
  return Number(row?.n ?? 0);
}
