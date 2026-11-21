import { and, asc, desc, eq, gte, inArray, isNull, isNotNull, lte, count, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { items, tags, itemTags, chunks, type Item, type Chunk, type ItemType, type ItemStatus } from "@/db/schema";
import { nowIso } from "@/lib/time";
import { deleteItemAttachments } from "@/domain/attachments";
import { chunkText } from "./chunk";
import { CaptureError } from "./capture";

export interface CreateItemInput {
  type: ItemType;
  title: string;
  body?: string;
  sourceUrl?: string;
  filePath?: string;
  mimeType?: string;
  /** Words lifted out of a file -- by the PDF extractor, by OCR, or simply read, for a file that
   * is already text. What `rechunkItem` indexes, so a file without it is unfindable. */
  extractedText?: string;
  meta?: Record<string, unknown>;
  status?: ItemStatus;
  journalDate?: string;
  reviewWeek?: string;
  containerId?: number | null;
}

export interface UpdateItemInput {
  title?: string;
  body?: string;
  extractedText?: string;
  status?: ItemStatus;
  error?: string | null;
  meta?: Record<string, unknown>;
  sourceUrl?: string | null;
  filePath?: string | null;
  mimeType?: string | null;
  containerId?: number | null;
  archivedAt?: string | null;
  pinned?: boolean;
}

export interface ListItemsFilter {
  type?: ItemType;
  /** Restrict to any of these types. Combines with `type` if both are given. */
  types?: ItemType[];
  status?: ItemStatus;
  tag?: string;
  /** Inclusive lower bound, YYYY-MM-DD (local start of day). */
  from?: string;
  /** Inclusive upper bound, YYYY-MM-DD (local end of day). */
  to?: string;
  limit?: number;
  offset?: number;
  /**
   * A container id, or null for the Inbox. Omit for any home. Whenever this is given
   * (including null, meaning the Inbox), pinned items sort first, then newest first.
   */
  containerId?: number | null;
  /** Archived items are hidden unless this is true. */
  includeArchived?: boolean;
  /** Only archived items; implies includeArchived. */
  onlyArchived?: boolean;
  /** Filter to pinned (true) or unpinned (false) items. Omit for either. */
  pinned?: boolean;
  /** Only items with a kept distillation (`meta.distillation.status === "kept"`). Omit for either. */
  distilled?: boolean;
  /**
   * What "first" means. The default is creation order, newest first, which is how every
   * existing caller reads a list; "updated" asks for the last touched instead, which is what
   * Home's Recent shows. Neither changes where pinned items sort when a home is named, and
   * neither moves `from`/`to`, which always window on creation.
   */
  orderBy?: "created" | "updated";
}

export function createItem(db: DB, input: CreateItemInput): Item {
  const now = nowIso();
  const row = db
    .insert(items)
    .values({
      type: input.type,
      title: input.title,
      body: input.body ?? "",
      status: input.status ?? "pending",
      sourceUrl: input.sourceUrl ?? null,
      filePath: input.filePath ?? null,
      mimeType: input.mimeType ?? null,
      extractedText: input.extractedText ?? "",
      meta: JSON.stringify(input.meta ?? {}),
      journalDate: input.journalDate ?? null,
      reviewWeek: input.reviewWeek ?? null,
      containerId: input.containerId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export function getItem(db: DB, id: number): Item | undefined {
  return db.select().from(items).where(eq(items.id, id)).get();
}

export function parseMeta<T = Record<string, unknown>>(item: Item): T {
  try {
    return JSON.parse(item.meta) as T;
  } catch {
    return {} as T;
  }
}

export function updateItem(db: DB, id: number, patch: UpdateItemInput): Item {
  const set: Partial<typeof items.$inferInsert> = { updatedAt: nowIso() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.extractedText !== undefined) set.extractedText = patch.extractedText;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.meta !== undefined) set.meta = JSON.stringify(patch.meta);
  if (patch.sourceUrl !== undefined) set.sourceUrl = patch.sourceUrl;
  if (patch.filePath !== undefined) set.filePath = patch.filePath;
  if (patch.mimeType !== undefined) set.mimeType = patch.mimeType;
  if (patch.containerId !== undefined) set.containerId = patch.containerId;
  if (patch.archivedAt !== undefined) set.archivedAt = patch.archivedAt;
  if (patch.pinned !== undefined) set.pinned = patch.pinned ? 1 : 0;
  const row = db.update(items).set(set).where(eq(items.id, id)).returning().get();
  if (!row) throw new Error(`Item ${id} not found`);
  return row;
}

export function mergeItemMeta(db: DB, id: number, patch: Record<string, unknown>): Item {
  const item = getItem(db, id);
  if (!item) throw new Error(`Item ${id} not found`);
  return updateItem(db, id, { meta: { ...parseMeta(item), ...patch } });
}

export function listItems(db: DB, filter: ListItemsFilter = {}): Item[] {
  const conds = [];
  if (filter.type) conds.push(eq(items.type, filter.type));
  if (filter.types && filter.types.length) conds.push(inArray(items.type, filter.types));
  if (filter.status) conds.push(eq(items.status, filter.status));
  if (filter.tag) {
    const ids = itemIdsWithTag(db, filter.tag);
    if (ids.length === 0) return [];
    conds.push(inArray(items.id, ids));
  }
  if (filter.from) conds.push(gte(items.createdAt, new Date(`${filter.from}T00:00:00`).toISOString()));
  if (filter.to) conds.push(lte(items.createdAt, new Date(`${filter.to}T23:59:59.999`).toISOString()));
  if (filter.containerId === null) conds.push(isNull(items.containerId));
  else if (typeof filter.containerId === "number") conds.push(eq(items.containerId, filter.containerId));
  if (filter.onlyArchived) conds.push(isNotNull(items.archivedAt));
  else if (!filter.includeArchived) conds.push(isNull(items.archivedAt));
  if (filter.pinned !== undefined) conds.push(eq(items.pinned, filter.pinned ? 1 : 0));
  if (filter.distilled) conds.push(sql`json_extract(${items.meta}, '$.distillation.status') = 'kept'`);
  const by = filter.orderBy === "updated" ? items.updatedAt : items.createdAt;
  const order = filter.containerId !== undefined ? [desc(items.pinned), desc(by), desc(items.id)] : [desc(by), desc(items.id)];
  return db
    .select()
    .from(items)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order)
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0)
    .all();
}

export function deleteItem(db: DB, id: number): void {
  db.transaction((tx) => {
    tx.delete(chunks).where(eq(chunks.itemId, id)).run();
    tx.delete(items).where(eq(items.id, id)).run();
  });
  deleteItemAttachments(id);
}

function normalizeTagNames(names: string[]): string[] {
  const set = new Set<string>();
  for (const n of names) {
    const name = n.trim().toLowerCase();
    if (name) set.add(name);
  }
  return [...set].sort();
}

export function setItemTags(db: DB, id: number, names: string[]): void {
  const normalized = normalizeTagNames(names);
  db.transaction((tx) => {
    tx.delete(itemTags).where(eq(itemTags.itemId, id)).run();
    for (const name of normalized) {
      tx.insert(tags).values({ name }).onConflictDoNothing().run();
      const tag = tx.select().from(tags).where(eq(tags.name, name)).get();
      if (!tag) throw new Error(`Tag ${name} missing after insert`);
      tx.insert(itemTags).values({ itemId: id, tagId: tag.id }).run();
    }
  });
}

export function getItemTags(db: DB, id: number): string[] {
  return db
    .select({ name: tags.name })
    .from(itemTags)
    .innerJoin(tags, eq(tags.id, itemTags.tagId))
    .where(eq(itemTags.itemId, id))
    .orderBy(asc(tags.name))
    .all()
    .map((r) => r.name);
}

export function listTagNames(db: DB): string[] {
  return db.select({ name: tags.name }).from(tags).orderBy(asc(tags.name)).all().map((r) => r.name);
}

/** Every tag with the number of items carrying it, most used first, then alphabetical. A
 * tag no item uses any more still counts, at zero. */
export function listTagsWithCounts(db: DB): { name: string; count: number }[] {
  const used = count(itemTags.itemId);
  return db
    .select({ name: tags.name, count: used })
    .from(tags)
    .leftJoin(itemTags, eq(itemTags.tagId, tags.id))
    .groupBy(tags.id)
    .orderBy(desc(used), asc(tags.name))
    .all();
}

function itemIdsWithTag(db: DB, name: string): number[] {
  return db
    .select({ itemId: itemTags.itemId })
    .from(itemTags)
    .innerJoin(tags, eq(tags.id, itemTags.tagId))
    .where(eq(tags.name, name.trim().toLowerCase()))
    .all()
    .map((r) => r.itemId);
}

/** Rebuild the chunks for an item from title, body, and extracted text. Returns the chunk count. */
export function rechunkItem(db: DB, id: number): number {
  const item = getItem(db, id);
  if (!item) throw new Error(`Item ${id} not found`);
  const text = [item.title, item.body, item.extractedText].filter((s) => s.trim().length > 0).join("\n\n");
  const parts = chunkText(text);
  db.transaction((tx) => {
    tx.delete(chunks).where(eq(chunks.itemId, id)).run();
    if (parts.length) {
      tx.insert(chunks)
        .values(parts.map((text, ordinal) => ({ itemId: id, ordinal, text })))
        .run();
    }
  });
  return parts.length;
}

export function getItemChunks(db: DB, id: number): Chunk[] {
  return db.select().from(chunks).where(eq(chunks.itemId, id)).orderBy(asc(chunks.ordinal)).all();
}

/** Move an item to a container (or the Inbox with null). */
export function fileItem(db: DB, id: number, containerId: number | null): Item {
  if (containerId !== null) {
    const exists = db.$client.prepare("SELECT id FROM containers WHERE id = ?").get(containerId);
    if (!exists) throw new Error(`Container ${containerId} not found`);
  }
  return updateItem(db, id, { containerId });
}

export function archiveItem(db: DB, id: number): Item {
  return updateItem(db, id, { archivedAt: nowIso() });
}

export function restoreItem(db: DB, id: number): Item {
  return updateItem(db, id, { archivedAt: null });
}

export function setItemPinned(db: DB, id: number, pinned: boolean): Item {
  if (!getItem(db, id)) throw new CaptureError(`Item ${id} not found`, 404);
  return updateItem(db, id, { pinned });
}

export function countInbox(db: DB): number {
  const row = db
    .select({ c: count() })
    .from(items)
    .where(and(isNull(items.containerId), isNull(items.archivedAt)))
    .get();
  return row?.c ?? 0;
}
