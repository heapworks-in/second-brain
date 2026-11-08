import { getDb } from "@/db/client";
import { Crumb } from "@/components/shell/crumb";
import { DeskPage } from "@/components/desk/desk-page";
import { deskPayload } from "@/domain/desk";

export const dynamic = "force-dynamic";

/**
 * The desk, assembled on the server so the first card is already there rather than arriving
 * after a spinner — the whole point is that it can be worked the moment it is open.
 *
 * `?p=<id>` puts one named proposal first, so a link from Home (and, later, a notification) can
 * hand over a single decision without the queue. It reorders rather than filters: answering it
 * should leave you on the desk with the rest, not at a dead end.
 */
export default async function Desk({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const { p } = await searchParams;
  const desk = deskPayload(getDb(), new Date());
  const wanted = Number(p);
  if (Number.isInteger(wanted)) {
    const i = desk.proposals.findIndex((proposal) => proposal.id === wanted);
    if (i > 0) desk.proposals = [desk.proposals[i], ...desk.proposals.filter((_, j) => j !== i)];
  }
  return (
    <>
      <Crumb title="Desk" />
      <DeskPage initial={desk} />
    </>
  );
}
