import fs from "node:fs";
import path from "node:path";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { items } from "@/db/schema";
import { captureFile, queueEmbedding } from "@/domain/items/capture";
import { getSetting } from "@/domain/settings";
import { dataDir } from "@/lib/paths";

/** Where documents are picked up from, unless a setting says otherwise. */
export const DEFAULT_DROP_DIR = path.join(dataDir(), "documents");

/** The setting that moves it. Empty means "use the default". */
export const DROP_DIR_SETTING = "library.dropDir";

/**
 * How deep a drop folder is walked.
 *
 * Shallow on purpose. A drop folder is a place to put things, and somebody who points this at
 * their whole home directory should get a bounded mistake rather than a week of OCR. Three levels
 * covers `documents/2026/specs/thing.pdf` and stops well short of a source tree.
 */
const MAX_DEPTH = 3;

/** The most files one pass will take. A hundred PDFs dropped at once become jobs, not a stall. */
const MAX_PER_PASS = 25;

/** Bigger than this is not a document somebody meant to put in a knowledge base. */
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Noise every real folder has, which nobody dropped there on purpose. `.DS_Store` is the one that
 * matters: without it the first pass over any folder a Mac user has opened in Finder ingests it.
 */
const IGNORED = new Set([".DS_Store", "Thumbs.db", ".localized", ".gitkeep"]);

export interface WatchResult {
  ingested: number;
  skipped: number;
  /** Named rather than counted: a file this cannot read is a document silently missing from the
   * knowledge base, and silence is the failure mode this whole folder is meant to remove. */
  failures: { file: string; reason: string }[];
}

export function dropDir(db: DB): string {
  return getSetting(db, DROP_DIR_SETTING, "").trim() || DEFAULT_DROP_DIR;
}

/**
 * Every file in the drop folder, shallowest first, with the noise left out.
 *
 * Shallowest first so that a folder holding both loose documents and a deep tree gets the loose
 * ones in on the first pass rather than spending the per-pass budget three levels down.
 */
function filesUnder(root: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const here: string[] = [];
  const deeper: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) deeper.push(...filesUnder(full, depth + 1));
    else if (entry.isFile()) here.push(full);
  }
  return [...here, ...deeper];
}

/**
 * What a file was when it was last taken in: its path, its size and its mtime.
 *
 * Stored on the item rather than in a table of its own, and matched on all three rather than on
 * the path alone, because a drop folder is re-read every few minutes and the alternatives are
 * both wrong. Matching on nothing re-ingests the same document on every pass; matching on the
 * path alone means editing a document in place leaves the knowledge base holding last week's
 * version, with no sign that it is stale.
 */
interface Source {
  path: string;
  size: number;
  mtime: number;
}

function sourceOf(item: { meta: string }): Source | null {
  try {
    const source = (JSON.parse(item.meta) as { source?: Partial<Source> }).source;
    if (!source || typeof source.path !== "string") return null;
    return { path: source.path, size: Number(source.size), mtime: Number(source.mtime) };
  } catch {
    return null;
  }
}

/**
 * Take in everything in the drop folder that is not already here, as it is now.
 *
 * Copies rather than references: `captureFile` saves its own copy under the data directory, so
 * the knowledge base owns what it indexed and a document is still readable after somebody tidies
 * their Downloads folder. The cost is disk, which for text and PDFs is not a real cost, and the
 * benefit is that nothing in the library can turn into a dead path.
 *
 * Errors are collected per file, never thrown. One unreadable document must not stop the pass:
 * the whole point of a folder is that you stop thinking about it, and a pass that aborts on the
 * first permission error would silently stop taking anything in.
 */
export function ingestDropFolder(db: DB, now = new Date()): WatchResult {
  const root = dropDir(db);
  const result: WatchResult = { ingested: 0, skipped: 0, failures: [] };
  if (!fs.existsSync(root)) return result;

  // One query for the folder's worth of known sources, not one per file: a pass over a hundred
  // documents should be one read of this table.
  const known = new Map<string, Source>();
  for (const row of db
    .select({ meta: items.meta })
    .from(items)
    .where(and(eq(items.type, "file"), like(items.meta, '%"source"%')))
    .all()) {
    const source = sourceOf(row);
    if (source) known.set(source.path, source);
  }

  for (const file of filesUnder(root)) {
    if (result.ingested >= MAX_PER_PASS) break;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      result.failures.push({ file, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (stat.size === 0 || stat.size > MAX_BYTES) {
      result.skipped += 1;
      continue;
    }
    const seen = known.get(file);
    if (seen && seen.size === stat.size && Math.floor(seen.mtime) === Math.floor(stat.mtimeMs)) {
      result.skipped += 1;
      continue;
    }
    try {
      const bytes = fs.readFileSync(file);
      captureFile(db, {
        bytes,
        name: path.basename(file),
        mime: "",
        meta: { source: { path: file, size: stat.size, mtime: stat.mtimeMs }, ingestedAt: now.toISOString() },
      });
      result.ingested += 1;
    } catch (err) {
      result.failures.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** The most items one pass will rebuild. Bounded like every other sweep here. */
const MAX_REINDEX = 10;

/**
 * Items holding text that no chunk was ever built from.
 *
 * A document in this state is in the library, has a title, opens, reads perfectly -- and does not
 * exist as far as search, the knowledge base and every answer built on it are concerned. There is
 * nothing to notice: no error, no pending status, no empty page. It is the quietest failure this
 * app has, and the only one that gets worse the more you trust the thing it breaks.
 *
 * Two of these were sitting in the live library when the eval was first run, and the eval only
 * found them because the questions happened to be about that document. Hence this, which does not
 * depend on anybody having written the right question.
 */
export function unindexedItems(db: DB, limit = MAX_REINDEX): { id: number; title: string }[] {
  return db
    .select({ id: items.id, title: items.title })
    .from(items)
    .where(
      and(
        isNull(items.archivedAt),
        // Real text, so an empty item is not reported forever as a thing to fix. Any non-empty
        // text produces at least one chunk, which is what makes a pass guaranteed to make
        // progress rather than retrying the same rows every two minutes.
        sql`trim(coalesce(${items.body}, '') || coalesce(${items.extractedText}, '')) <> ''`,
        sql`not exists (select 1 from chunks where chunks.item_id = ${items.id})`,
      ),
    )
    .orderBy(items.id)
    .limit(limit)
    .all();
}

/**
 * Rebuild the chunks for anything holding text that was never indexed, and return how many.
 *
 * Self-healing rather than a repair button, because the failure is invisible and nobody will ever
 * go and press one. Whatever put an item in this state -- a handler that forgot, a job that died
 * between writing the text and indexing it, a version of this app from before the step existed --
 * the next pass picks it up.
 */
export function reindexOrphans(db: DB, limit = MAX_REINDEX): { id: number; title: string }[] {
  const orphans = unindexedItems(db, limit);
  for (const item of orphans) queueEmbedding(db, item.id);
  return orphans;
}
