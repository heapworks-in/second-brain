import { and, eq, gte, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { proposals } from "@/db/schema";
import type { DeskDTO, ProposalDTO } from "@/lib/dto";
import { localDay } from "@/lib/time";
import { dismissRate, OPEN_CAP } from "./rank";
import { openProposals } from "./reconcile";

export { OPEN_CAP } from "./rank";
export { reconcileProposals, openProposals } from "./reconcile";
export { decideProposal, undoProposal, DeskError } from "./decide";
export type { ProposalDraft, Generator } from "./types";

/**
 * The desk as the page reads it: the capped list, how many are really waiting, and how much has
 * been answered today.
 *
 * `open` can exceed the list's length, and saying so is the point -- the cap is a deliberate
 * limit rather than a coincidence, and a desk that showed seven of nineteen without saying
 * nineteen would be hiding its own arithmetic.
 */
export function deskPayload(db: DB, now: Date): DeskDTO {
  const rows = openProposals(db, OPEN_CAP);
  const rates = new Map(rows.map((r) => [r.kind, 0]));
  for (const kind of rates.keys()) rates.set(kind, dismissRate(db, kind));

  const open = db.select({ n: sql<number>`count(*)` }).from(proposals).where(eq(proposals.state, "open")).get()?.n ?? 0;
  const today = localDay(now.toISOString());
  const decidedToday =
    db
      .select({ n: sql<number>`count(*)` })
      .from(proposals)
      .where(and(gte(proposals.decidedAt, `${today}T00:00:00.000Z`), sql`${proposals.state} in ('accepted', 'dismissed')`))
      .get()?.n ?? 0;

  const list: ProposalDTO[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    source: r.source,
    title: r.title,
    detail: r.detail,
    rank: r.rank,
    createdAt: r.createdAt,
    dismissRate: rates.get(r.kind) ?? 0,
  }));

  return { proposals: list, open, decidedToday };
}
