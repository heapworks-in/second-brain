import { and, eq, gte, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { proposals } from "@/db/schema";
import type { DeskDTO, ProposalDTO } from "@/lib/dto";
import { startOfLocalDay } from "@/lib/time";
import { dismissRate, BOARD_CEILING } from "./rank";
import { originOf } from "./origin";
import { openProposals } from "./reconcile";

export { BOARD_CEILING } from "./rank";
export { reconcileProposals, openProposals } from "./reconcile";
export { decideProposal, undoProposal, DeskError } from "./decide";
export type { ProposalDraft, Generator } from "./types";

/**
 * The desk as the page reads it: the capped list, how many are really waiting, and how much has
 * been answered today.
 *
 * Everything open is returned, up to a ceiling that exists only so one runaway generator cannot
 * render ten thousand rows. `open` can still exceed the list's length, and saying so remains the
 * point: a desk that showed some of nineteen without saying nineteen would be hiding its own
 * arithmetic.
 */
function parsePayload(payload: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Absent means one. Grouped cards are the exception, so the common row stores nothing. */
function countOf(payload: string): number {
  const n = parsePayload(payload).count;
  return typeof n === "number" && n > 1 ? n : 1;
}

export function deskPayload(db: DB, now: Date): DeskDTO {
  const rows = openProposals(db, BOARD_CEILING);
  const rates = new Map(rows.map((r) => [r.kind, 0]));
  for (const kind of rates.keys()) rates.set(kind, dismissRate(db, kind));

  const open = db.select({ n: sql<number>`count(*)` }).from(proposals).where(eq(proposals.state, "open")).get()?.n ?? 0;
  const decidedToday =
    db
      .select({ n: sql<number>`count(*)` })
      .from(proposals)
      .where(and(gte(proposals.decidedAt, startOfLocalDay(now)), sql`${proposals.state} in ('accepted', 'dismissed')`))
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
    count: countOf(r.payload),
    origin: originOf(db, r.kind, parsePayload(r.payload)),
  }));

  return { proposals: list, open, decidedToday };
}
