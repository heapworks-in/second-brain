import type { TaskStatus } from "@/db/enums";

/** The fields a tracker row can fill. Everything else in the file is kept verbatim and handed
 * back on export, so this list is deliberately short: these are the columns the app can *act*
 * on, not the columns worth keeping. */
export const TRACKER_FIELDS = ["theme", "task", "subTask", "owner", "eta", "team", "comments", "status"] as const;
export type TrackerField = (typeof TRACKER_FIELDS)[number];

/** Which header answers which field, plus how the theme column should be read. A field with no
 * header is a field the sheet does not have. */
export interface Mapping {
  columns: Partial<Record<TrackerField, string>>;
  /** `group` keeps Theme as a label on each row; `container` files each row in the project of
   * that name. The preview asks rather than guessing, because both are real ways to run a sheet. */
  theme: "group" | "container";
}

/**
 * What a header has to look like to claim a field, best guess first.
 *
 * Deliberately dull: normalise, then look for an exact match, then for one of these as a word
 * inside the header ("Target ETA (IST)"). No fuzzy distance, no stemming -- a wrong guess here
 * silently files a comment as a title, and the preview is where guesses are confirmed anyway.
 */
const SYNONYMS: Record<TrackerField, string[]> = {
  theme: ["theme", "workstream", "work stream", "epic", "category", "bucket", "track", "module"],
  task: ["task", "activity", "deliverable", "item", "title", "summary", "work item"],
  subTask: ["sub task", "subtask", "sub-task", "sub activity", "subactivity", "step", "child task"],
  owner: ["owner", "assignee", "assigned to", "responsible", "spoc", "dri", "accountable", "who"],
  eta: ["eta", "due", "due date", "target date", "target", "deadline", "by when", "finish date", "end date"],
  team: ["team", "group", "function", "department", "dept", "squad", "pod"],
  comments: ["comments", "comment", "remarks", "notes", "update", "updates", "status update", "details"],
  status: ["status", "state", "progress", "stage"],
};

function normalise(header: string): string {
  return header.toLowerCase().replace(/[_\-/]+/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The column the app writes its own ids into on export, so a re-import of its own file matches
 * row for row instead of guessing. */
export const ID_HEADER = "SB ID";

/**
 * A first pass at the mapping, for the preview to show and the person to correct.
 *
 * Longer synonyms win: "sub task" must beat "task" for a header called "Sub task", and the
 * single-word check running first would claim it for `task` and leave sub-tasks unmapped.
 */
export function guessMapping(headers: string[]): Mapping["columns"] {
  const columns: Mapping["columns"] = {};
  const claimed = new Set<string>();
  const candidates = TRACKER_FIELDS.flatMap((field) => SYNONYMS[field].map((word) => ({ field, word })))
    .sort((a, b) => b.word.length - a.word.length);

  for (const { field, word } of candidates) {
    if (columns[field]) continue;
    const exact = headers.find((h) => !claimed.has(h) && normalise(h) === word);
    const hit = exact ?? headers.find((h) => !claimed.has(h) && new RegExp(`(^| )${word}( |$)`).test(normalise(h)));
    if (hit) {
      columns[field] = hit;
      claimed.add(hit);
    }
  }
  return columns;
}

/** The status words this sheet uses, in the order they first appear -- what the preview asks
 * about and the tracker remembers. */
export function statusWords(rows: Record<string, string>[], header: string | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const row of rows) {
    const word = (row[header] ?? "").trim();
    if (word && !out.some((w) => w.toLowerCase() === word.toLowerCase())) out.push(word);
  }
  return out;
}

const DONE = ["done", "complete", "completed", "closed", "shipped", "delivered", "resolved", "finished"];
const DROPPED = ["dropped", "cancelled", "canceled", "wont do", "won t do", "will not do", "not doing", "descoped", "de scoped", "obsolete"];

/**
 * The lifecycle a status word means, or null when the app has no opinion.
 *
 * Null is the useful answer, not a failure: "Blocked", "On Hold" and "In Progress" are all
 * genuinely open, and the word itself survives in `statusLabel` either way. Only the two ends of
 * the lifecycle change what the app does, so only they are guessed.
 */
export function guessStatus(word: string): TaskStatus | null {
  const w = normalise(word);
  if (!w) return null;
  if (DONE.some((d) => w === d || w.startsWith(`${d} `))) return "done";
  if (DROPPED.some((d) => w === d || w.startsWith(`${d} `))) return "dropped";
  return null;
}

export function guessStatusMap(words: string[]): Record<string, TaskStatus> {
  const map: Record<string, TaskStatus> = {};
  for (const word of words) {
    const guess = guessStatus(word);
    if (guess) map[word] = guess;
  }
  return map;
}

/**
 * An ETA as a date, or null when it is prose.
 *
 * Day first for the ambiguous `03/04/2026`, which the preview says out loud rather than leaving
 * to be discovered in October. What does not parse -- "mid Nov", "W47", "after the audit" -- is
 * reported row by row and left in the sheet's own column, never guessed into a deadline.
 */
export function parseEta(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (!slash) return null;
  const day = Number(slash[1]);
  const month = Number(slash[2]);
  const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  // Rejects 31/02: the constructor rolls it into March rather than refusing it.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
