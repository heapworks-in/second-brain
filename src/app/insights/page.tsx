import { getDb } from "@/db/client";
import { Crumb } from "@/components/shell/crumb";
import { InsightsPage } from "@/components/insights/insights-page";
import { collectInsights } from "@/domain/insights";

export const dynamic = "force-dynamic";

/** Computed on read rather than swept: insights are derived facts, and a table would be a cache
 *  of something cheap to recompute. */
export default function Insights() {
  const insights = collectInsights(getDb(), new Date());
  return (
    <>
      <Crumb title="Insights" />
      <InsightsPage insights={insights} />
    </>
  );
}
