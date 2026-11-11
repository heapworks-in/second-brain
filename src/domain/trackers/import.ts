import { eq } from "drizzle-orm";
import type { DB } from "@/db/client";
import type { TaskStatus } from "@/db/enums";
import { tasks, trackers, type Task, type Tracker } from "@/db/schema";
import { slugify } from "@/domain/containers";
import { createContainer, listContainers } from "@/domain/containers";
import { createPerson, listPeople, updatePerson } from "@/domain/people";
import { createTask, listTasks, updateTask } from "@/domain/tasks";
import { nowIso } from "@/lib/time";
import { ID_HEADER, parseEta, type Mapping, TRACKER_FIELDS } from "./mapping";

export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TrackerError";
  }
}

export interface ImportInput {
  /** What the tracker is called here. Defaults to the sheet or file name upstream, never guessed. */
  name: string;
  containerId: number | null;
  sourceName: string;
  sheetName: string;
  headers: string[];
  rows: Record<string, string>[];
  mapping: Mapping;
  statusMap: Record<string, TaskStatus>;
  /** The spellings of my own name in this file's owner column. Rows naming one of them are mine. */
  identityNames: string[];
  /** Importing again into a tracker that already exists: rows match, rather than double. */
  trackerId?: number;
}

/** What one row of the file will become, as the preview shows it and `applyImport` writes it. */
export interface PlannedRow {
  /** The row's number in the file's body, 1-based: what the preview points at when something
   * could not be read. */
  row: number;
  title: string;
  parentLabel: string;
  theme: string;
  ownerName: string;
  /** Null for me. */
  ownerPersonId: number | null;
  team: string;
  dueDate: string | null;
  /** An ETA that is prose rather than a date: kept in the sheet's column, never guessed. */
  etaText: string;
  notes: string;
  status: TaskStatus;
  statusLabel: string;
  sheetExtra: Record<string, string>;
  /** The task this row updates, when the file carries an `SB ID` or the row matches one. */
  taskId: number | null;
  verdict: "create" | "update" | "skip";
  /** Why a row is being skipped, for the one line the preview shows beside it. */
  reason?: string;
}

export interface ImportPlan {
  rows: PlannedRow[];
  counts: { create: number; update: number; skip: number };
  /** Owners in the file, with the person they match here. A null id is somebody who would be
   * created; `isMe` is the row the identity setting claims. */
  people: { name: string; personId: number | null; isMe: boolean; rows: number }[];
  /** Projects the file names, when Theme is being read as the project each row belongs to. */
  containers: { name: string; containerId: number | null; rows: number }[];
  /** Status words with no lifecycle agreed yet. They import as open and keep their word. */
  unknownStatuses: string[];
  /** ETAs that are not dates, by row. */
  unparsedEtas: { row: number; text: string }[];
  /** Headers the mapping does not claim. Kept verbatim on every row so an export rebuilds the
   * file whole, which is the only reason they are worth saying out loud. */
  keptColumns: string[];
}

function cell(row: Record<string, string>, header: string | undefined): string {
  return header ? (row[header] ?? "").trim() : "";
}

/** Two titles are the same row of the same sheet when they read the same to a person. */
function key(theme: string, parentLabel: string, title: string): string {
  const flat = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return `${flat(theme)}\u0000${flat(parentLabel)}\u0000${flat(title)}`;
}

/**
 * What an import would do, row by row, with nothing written.
 *
 * Every surprise a real file holds is reported rather than resolved: an owner nobody here knows,
 * a status word the app has no opinion about, an ETA that reads "mid Nov". The preview is the
 * only place those get decided, which is why this function writes nothing at all -- a preview
 * that half-imported would be worse than none.
 */
export function previewImport(db: DB, input: ImportInput): ImportPlan {
  const columns = input.mapping.columns;
  const people = listPeople(db);
  const byName = new Map(people.map((p) => [p.name.toLowerCase(), p]));
  const mine = new Set(input.identityNames.map((n) => n.toLowerCase().trim()).filter(Boolean));
  const existing = input.trackerId === undefined ? [] : listTasks(db, { trackerId: input.trackerId, status: "all", owner: "anyone" });
  const byId = new Map(existing.map((t) => [t.id, t]));
  const byKey = new Map(existing.map((t) => [key(t.theme, t.parentLabel, t.title), t]));
  const claimed = new Set([...TRACKER_FIELDS.map((f) => columns[f]).filter((h): h is string => !!h), ID_HEADER]);
  const keptColumns = input.headers.filter((h) => !claimed.has(h));
  const containerNames = new Map<string, number>();
  const containersByName = new Map(listContainers(db, {}).map((c) => [c.name.toLowerCase(), c]));

  const unknownStatuses: string[] = [];
  const unparsedEtas: { row: number; text: string }[] = [];
  const ownerRows = new Map<string, number>();
  const seen = new Set<string>();

  const rows = input.rows.map((raw, i): PlannedRow => {
    const row = i + 1;
    const theme = cell(raw, columns.theme);
    const taskText = cell(raw, columns.task);
    const subText = cell(raw, columns.subTask);
    const title = subText || taskText;
    const parentLabel = subText ? taskText : "";
    const ownerName = cell(raw, columns.owner);
    const etaText = cell(raw, columns.eta);
    const dueDate = parseEta(etaText);
    const statusLabel = cell(raw, columns.status);
    const status = input.statusMap[statusLabel] ?? "open";
    const sheetExtra: Record<string, string> = {};
    for (const h of keptColumns) if (cell(raw, h)) sheetExtra[h] = cell(raw, h);

    if (ownerName) ownerRows.set(ownerName, (ownerRows.get(ownerName) ?? 0) + 1);
    if (statusLabel && !(statusLabel in input.statusMap) && !unknownStatuses.includes(statusLabel)) unknownStatuses.push(statusLabel);
    if (etaText && dueDate === null) unparsedEtas.push({ row, text: etaText });
    if (input.mapping.theme === "container" && theme) {
      const match = containersByName.get(theme.toLowerCase());
      containerNames.set(theme, (containerNames.get(theme) ?? 0) + 1);
      if (match) containerNames.set(theme, containerNames.get(theme)!);
    }

    const isMine = mine.has(ownerName.toLowerCase());
    const owner = isMine || !ownerName ? null : (byName.get(ownerName.toLowerCase())?.id ?? null);

    const base = { row, title, parentLabel, theme, ownerName, ownerPersonId: owner, team: cell(raw, columns.team), dueDate, etaText, notes: cell(raw, columns.comments), status, statusLabel, sheetExtra };
    if (!title) return { ...base, taskId: null, verdict: "skip", reason: "no task or sub-task to name it" };

    const idText = (raw[ID_HEADER] ?? "").trim();
    const byIdMatch = idText && /^\d+$/.test(idText) ? byId.get(Number(idText)) : undefined;
    const match: Task | undefined = byIdMatch ?? byKey.get(key(theme, parentLabel, title));
    const rowKey = key(theme, parentLabel, title);
    if (!match && seen.has(rowKey)) return { ...base, taskId: null, verdict: "skip", reason: "the same row appears twice in the file" };
    seen.add(rowKey);
    return { ...base, taskId: match?.id ?? null, verdict: match ? "update" : "create" };
  });

  return {
    rows,
    counts: {
      create: rows.filter((r) => r.verdict === "create").length,
      update: rows.filter((r) => r.verdict === "update").length,
      skip: rows.filter((r) => r.verdict === "skip").length,
    },
    people: [...ownerRows.entries()].map(([name, count]) => ({
      name,
      personId: byName.get(name.toLowerCase())?.id ?? null,
      isMe: mine.has(name.toLowerCase()),
      rows: count,
    })),
    containers:
      input.mapping.theme === "container"
        ? [...containerNames.entries()].map(([name, count]) => ({ name, containerId: containersByName.get(name.toLowerCase())?.id ?? null, rows: count }))
        : [],
    unknownStatuses,
    unparsedEtas,
    keptColumns,
  };
}

function uniqueSlug(db: DB, name: string, excludeId?: number): string {
  const base = slugify(name) || "tracker";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const existing = db.select({ id: trackers.id }).from(trackers).where(eq(trackers.slug, candidate)).get();
    if (!existing || existing.id === excludeId) return candidate;
  }
}

/**
 * Write the import.
 *
 * The plan is recomputed here rather than taken from the caller: a preview is a screen somebody
 * read ten minutes ago, and the database may have moved since. What the caller decides -- the
 * mapping, the status words, which names are mine -- is input; what that means for each row is
 * worked out again against the data as it is now.
 */
export function applyImport(db: DB, input: ImportInput): { tracker: Tracker; created: number; updated: number; skipped: number; peopleCreated: string[] } {
  if (!input.name.trim()) throw new TrackerError("A tracker needs a name");
  const now = nowIso();
  const peopleCreated: string[] = [];

  // People and projects first, outside the row loop: the same owner names 40 rows, and each one
  // must resolve to the same person rather than to 40.
  const plan = previewImport(db, input);
  const personByName = new Map<string, number>();
  for (const person of plan.people) {
    if (person.isMe || !person.name) continue;
    if (person.personId !== null) {
      personByName.set(person.name.toLowerCase(), person.personId);
      continue;
    }
    const team = plan.rows.find((r) => r.ownerName === person.name && r.team)?.team ?? "";
    const made = createPerson(db, { name: person.name, team });
    peopleCreated.push(made.name);
    personByName.set(person.name.toLowerCase(), made.id);
  }
  // A team column is worth something on a person who has none; it never overwrites one.
  for (const person of plan.people) {
    const id = personByName.get(person.name.toLowerCase());
    const team = plan.rows.find((r) => r.ownerName === person.name && r.team)?.team;
    if (!id || !team) continue;
    const current = listPeople(db).find((p) => p.id === id);
    if (current && !current.team) updatePerson(db, id, { team });
  }

  const containerByName = new Map<string, number>();
  for (const c of plan.containers) {
    containerByName.set(c.name.toLowerCase(), c.containerId ?? createContainer(db, { kind: "project", name: c.name }).id);
  }

  const tracker =
    input.trackerId === undefined
      ? db
          .insert(trackers)
          .values({
            name: input.name.trim(),
            slug: uniqueSlug(db, input.name),
            containerId: input.containerId,
            sourceName: input.sourceName,
            sheetName: input.sheetName,
            headers: JSON.stringify(input.headers),
            mapping: JSON.stringify(input.mapping),
            statusMap: JSON.stringify(input.statusMap),
            importedAt: now,
            updatedAt: now,
          })
          .returning()
          .get()
      : db
          .update(trackers)
          .set({ headers: JSON.stringify(input.headers), mapping: JSON.stringify(input.mapping), statusMap: JSON.stringify(input.statusMap), updatedAt: now })
          .where(eq(trackers.id, input.trackerId))
          .returning()
          .get();
  if (!tracker) throw new TrackerError(`Tracker ${input.trackerId} not found`, 404);

  let created = 0;
  let updated = 0;
  for (const row of plan.rows) {
    if (row.verdict === "skip") continue;
    const ownerPersonId = row.ownerName && !plan.people.find((p) => p.name === row.ownerName)?.isMe ? (personByName.get(row.ownerName.toLowerCase()) ?? null) : null;
    const containerId = input.mapping.theme === "container" && row.theme ? (containerByName.get(row.theme.toLowerCase()) ?? null) : input.containerId;
    const fields = {
      title: row.title,
      notes: row.notes,
      dueDate: row.dueDate,
      containerId,
      ownerPersonId,
      theme: input.mapping.theme === "container" ? "" : row.theme,
      parentLabel: row.parentLabel,
      statusLabel: row.statusLabel,
      sheetExtra: row.sheetExtra,
      sheetRow: row.row,
      trackerId: tracker.id,
      status: row.status,
    };
    if (row.taskId === null) {
      createTask(db, fields);
      created++;
    } else {
      updateTask(db, row.taskId, fields);
      updated++;
    }
  }

  return { tracker, created, updated, skipped: plan.counts.skip, peopleCreated };
}
