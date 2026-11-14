import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { items, people, itemPeople, type Item, type Person } from "@/db/schema";
import { slugify } from "@/domain/containers";
import { extractMentions } from "@/lib/mentions";
import { nowIso } from "@/lib/time";

export { extractMentions } from "@/lib/mentions";

export class PersonError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "PersonError";
  }
}

function uniqueSlug(db: DB, name: string, excludeId?: number): string {
  const base = slugify(name);
  let candidate = base;
  for (let n = 2; ; n++) {
    const existing = db.select({ id: people.id }).from(people).where(eq(people.slug, candidate)).get();
    if (!existing || existing.id === excludeId) return candidate;
    candidate = `${base}-${n}`;
  }
}

export function createPerson(db: DB, input: { name: string; profile?: string; organization?: string; team?: string; title?: string }): Person {
  const name = input.name.trim();
  if (!name) throw new PersonError("Name is required");
  const now = nowIso();
  const row = db
    .insert(people)
    .values({
      name,
      slug: uniqueSlug(db, name),
      profile: input.profile ?? "",
      organization: input.organization ?? "",
      team: input.team ?? "",
      title: input.title ?? "",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export function getPerson(db: DB, id: number): Person | undefined {
  return db.select().from(people).where(eq(people.id, id)).get();
}

export function getPersonBySlug(db: DB, slug: string): Person | undefined {
  return db.select().from(people).where(eq(people.slug, slug)).get();
}

export function listPeople(db: DB): (Person & { itemCount: number; lastContact: string | null; meetingCount: number })[] {
  const rows = db.select().from(people).orderBy(asc(people.name)).all();
  const counts = db
    .select({
      personId: itemPeople.personId,
      c: sql<number>`count(*)`,
      lastContact: sql<string | null>`max(${items.createdAt})`,
      meetings: sql<number>`sum(case when ${items.type} = 'meeting' then 1 else 0 end)`,
    })
    .from(itemPeople)
    .innerJoin(items, eq(items.id, itemPeople.itemId))
    .where(isNull(items.archivedAt))
    .groupBy(itemPeople.personId)
    .all();
  const byId = new Map(counts.map((c) => [c.personId, c]));
  return rows.map((p) => {
    const c = byId.get(p.id);
    return { ...p, itemCount: c ? Number(c.c) : 0, lastContact: c?.lastContact ?? null, meetingCount: c ? Number(c.meetings) : 0 };
  });
}

export function updatePerson(
  db: DB,
  id: number,
  patch: { name?: string; profile?: string; organization?: string; team?: string; title?: string },
): Person {
  const current = getPerson(db, id);
  if (!current) throw new PersonError(`Person ${id} not found`, 404);
  const set: Partial<typeof people.$inferInsert> = { updatedAt: nowIso() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new PersonError("Name is required");
    set.name = name;
    if (name !== current.name) set.slug = uniqueSlug(db, name, id);
  }
  if (patch.profile !== undefined) set.profile = patch.profile;
  if (patch.organization !== undefined) set.organization = patch.organization;
  if (patch.team !== undefined) set.team = patch.team;
  if (patch.title !== undefined) set.title = patch.title;
  const row = db.update(people).set(set).where(eq(people.id, id)).returning().get();
  if (!row) throw new PersonError(`Person ${id} not found`, 404);
  return row;
}

export function deletePerson(db: DB, id: number): void {
  if (!getPerson(db, id)) throw new PersonError(`Person ${id} not found`, 404);
  db.delete(people).where(eq(people.id, id)).run();
}

export function setItemPeople(db: DB, itemId: number, personIds: number[]): void {
  const unique = [...new Set(personIds)];
  db.transaction((tx) => {
    tx.delete(itemPeople).where(eq(itemPeople.itemId, itemId)).run();
    if (unique.length) tx.insert(itemPeople).values(unique.map((personId) => ({ itemId, personId }))).run();
  });
}

export function addItemPerson(db: DB, itemId: number, personId: number): void {
  db.insert(itemPeople).values({ itemId, personId }).onConflictDoNothing().run();
}

export function getItemPeople(db: DB, itemId: number): Person[] {
  return db
    .select({
      id: people.id,
      name: people.name,
      slug: people.slug,
      profile: people.profile,
      organization: people.organization,
      team: people.team,
      title: people.title,
      createdAt: people.createdAt,
      updatedAt: people.updatedAt,
    })
    .from(itemPeople)
    .innerJoin(people, eq(people.id, itemPeople.personId))
    .where(eq(itemPeople.itemId, itemId))
    .orderBy(asc(people.name))
    .all();
}

/** The named people, by id, in one query -- for a list of rows that each point at one person
 * (a task's requester) rather than a row with a list of people (an item's attendees). */
export function peopleByIds(db: DB, ids: number[]): Map<number, Person> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  return new Map(db.select().from(people).where(inArray(people.id, unique)).all().map((p) => [p.id, p]));
}

export function getPersonTimeline(db: DB, personId: number, includeArchived = false): Item[] {
  const ids = db
    .select({ itemId: itemPeople.itemId })
    .from(itemPeople)
    .where(eq(itemPeople.personId, personId))
    .all()
    .map((r) => r.itemId);
  if (ids.length === 0) return [];
  const conds = [inArray(items.id, ids)];
  if (!includeArchived) conds.push(isNull(items.archivedAt));
  return db
    .select()
    .from(items)
    .where(and(...conds))
    .orderBy(desc(items.createdAt), desc(items.id))
    .all();
}

/** Link every `@handle` in the item body to a person whose slug matches. Never removes links. */
export function autoLinkMentions(db: DB, itemId: number): number {
  const item = db.select({ body: items.body }).from(items).where(eq(items.id, itemId)).get();
  if (!item) return 0;
  const handles = extractMentions(item.body);
  if (handles.length === 0) return 0;
  const matches = db.select({ id: people.id }).from(people).where(inArray(people.slug, handles)).all();
  const already = new Set(getItemPeople(db, itemId).map((p) => p.id));
  let added = 0;
  for (const m of matches) {
    if (already.has(m.id)) continue;
    addItemPerson(db, itemId, m.id);
    added++;
  }
  return added;
}

/**
 * The person behind an outside ask, made if this is the first time they have appeared.
 *
 * Matched on the display name before the handle, and that order is the point: somebody first
 * met in a meeting is stored as "Priya Raman", while Slack hands over "@priya". Matching on the
 * slug alone would invent a second Priya on her first message and split her timeline in two.
 *
 * Returns whether it created anyone, so an undo can remove a person this press invented without
 * touching one who was already known.
 */
export function findOrCreateActor(db: DB, name: string | null, handle: string | null): { person: Person; created: boolean } {
  const cleanName = name?.trim() ?? "";
  if (cleanName) {
    const byName = db
      .select()
      .from(people)
      .where(sql`lower(${people.name}) = ${cleanName.toLowerCase()}`)
      .get();
    if (byName) return { person: byName, created: false };
  }
  const cleanHandle = handle?.trim().toLowerCase() ?? "";
  if (cleanHandle) {
    const bySlug = getPersonBySlug(db, cleanHandle);
    if (bySlug) return { person: bySlug, created: false };
  }
  const label = cleanName || cleanHandle;
  if (!label) throw new PersonError("An ask with no name and no handle has nobody waiting on it");
  return { person: createPerson(db, { name: label }), created: true };
}
