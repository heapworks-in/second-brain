import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { proposals } from "@/db/schema";
import { dismissRates, rankDraft } from "./rank";
import type { ProposalDraft } from "./types";

export interface ReconcileResult {
  /** Drafts that had no row and now do. */
  opened: number;
  /** Open rows whose generator stopped emitting them. */
  expired: number;
  /** Snoozed rows whose snooze ran out. */
  returned: number;
  /** Rows already there and still emitted; re-ranked, otherwise untouched. */
  refreshed: number;
}

/**
 * Fold a sweep's drafts into the table. The only writer of `proposals` that a sweep ever uses.
 *
 * Three rules, and the first is the one the whole surface rests on:
 *
 * 1. **A decision is never undone by a sweep.** The upsert matches on `(kind, source_ref)` and
 *    touches `state` only for a snooze that has run out. A dismissed proposal whose condition is
 *    still true gets re-emitted on every single sweep -- fifteen minutes apart, forever -- so if
 *    the upsert reset `state` the desk would re-ask everything within the quarter hour and be
 *    worth nothing. This is the bug that would make the feature untrustworthy rather than buggy.
 * 2. **A condition that resolves itself leaves on its own.** An `open` row nobody emitted this
 *    sweep becomes `expired`: the meeting happened, the task got worked, the capture was filed
 *    by hand. Without this the cap fills with cards that answer themselves and the desk stops
 *    being clearable.
 * 3. **A snooze is a date, not a state to be remembered.** `snoozed` rows past `snoozedUntil`
 *    return to `open` here, so "not now" needs nothing to wake it up later.
 *
 * `title`, `detail` and `payload` are refreshed on every sweep, because the evidence moves: a
 * meeting is two hours away rather than four, a task has overrun further. `createdAt` never
 * moves -- it is when the desk first noticed, which is the honest thing for a card to be able
 * to say.
 */
export function reconcileProposals(db: DB, drafts: ProposalDraft[], now: Date): ReconcileResult {
  const at = now.toISOString();
  const rates = dismissRates(db, drafts.map((d) => d.kind));
  // Ranked before the transaction opens, not inside it: ranking reads settings and counts past
  // decisions, and neither depends on anything this transaction is about to write.
  const ranks = new Map(drafts.map((d) => [`${d.kind}\u0000${d.sourceRef}`, rankDraft(db, d, rates)]));
  const result: ReconcileResult = { opened: 0, expired: 0, returned: 0, refreshed: 0 };

  db.transaction((tx) => {
    // A snooze that has run out comes back first, so a draft arriving for the same row this
    // sweep sees it as open rather than as something to leave alone.
    result.returned = tx
      .update(proposals)
      .set({ state: "open", snoozedUntil: null })
      .where(and(eq(proposals.state, "snoozed"), lte(proposals.snoozedUntil, at)))
      .run().changes;

    const existing = new Map(
      tx
        .select({ id: proposals.id, kind: proposals.kind, sourceRef: proposals.sourceRef, state: proposals.state })
        .from(proposals)
        .all()
        .map((r) => [`${r.kind}\u0000${r.sourceRef}`, r]),
    );

    for (const draft of drafts) {
      const key = `${draft.kind}\u0000${draft.sourceRef}`;
      const row = existing.get(key);
      const rank = ranks.get(key) ?? 0;
      if (!row) {
        tx.insert(proposals)
          .values({
            kind: draft.kind,
            source: draft.source,
            sourceRef: draft.sourceRef,
            title: draft.title,
            detail: draft.detail,
            payload: JSON.stringify(draft.payload),
            rank,
            state: "open",
            createdAt: at,
          })
          .run();
        result.opened += 1;
        continue;
      }
      // Evidence and rank are refreshed whatever the state, so a dismissed proposal that is
      // looked at later still reads correctly -- but `state` and `decidedAt` are not in this
      // `set`, which is rule 1 above and the reason this is not a plain upsert.
      tx.update(proposals)
        .set({ title: draft.title, detail: draft.detail, payload: JSON.stringify(draft.payload), rank })
        .where(eq(proposals.id, row.id))
        .run();
      result.refreshed += 1;
    }

    const emitted = new Set(drafts.map((d) => `${d.kind}\u0000${d.sourceRef}`));
    const stale = [...existing.values()].filter((r) => r.state === "open" && !emitted.has(`${r.kind}\u0000${r.sourceRef}`));
    if (stale.length > 0) {
      result.expired = tx
        .update(proposals)
        .set({ state: "expired", decidedAt: at })
        .where(inArray(proposals.id, stale.map((r) => r.id)))
        .run().changes;
    }
  });

  return result;
}

/** What the desk shows: open, best first, capped. The cap is applied here rather than in the
 * page, so every surface that asks agrees on what "on the desk" means. */
export function openProposals(db: DB, limit: number) {
  return db
    .select()
    .from(proposals)
    .where(eq(proposals.state, "open"))
    .orderBy(sql`${proposals.rank} desc, ${proposals.createdAt} asc`)
    .limit(limit)
    .all();
}
