import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { getDb } from "@/db/client";
import { Crumb } from "@/components/shell/crumb";
import { getContainer } from "@/domain/containers";
import { getTrackerBySlug, trackerCounts, trackerRows } from "@/domain/trackers/export";
import { TrackerTable } from "@/components/trackers/tracker-table";
import { DeleteTracker } from "@/components/trackers/delete-tracker";
import { PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function TrackerPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  const tracker = getTrackerBySlug(db, slug);
  if (!tracker) notFound();
  const rows = trackerRows(db, tracker.id);
  const counts = trackerCounts(db, tracker.id);
  const container = tracker.containerId === null ? null : getContainer(db, tracker.containerId);

  return (
    <>
      <Crumb title={tracker.name} />
      <div className="w-full px-6 lg:px-8 pt-8 flex flex-col gap-5">
      <PageHeader
        title={tracker.name}
        meta={
          <>
            <span className="font-mono">
              {counts.rows} rows · {counts.mine} yours · {counts.done} done
            </span>{" "}
            {container && (
              <>
                <span>in</span>{" "}
                <Link href={`/containers/${container.slug}`} className="focus-ring text-violet-bright hover:underline rounded-sm">
                  {container.name}
                </Link>{" "}
              </>
            )}
            <span>· Imported {formatDate(tracker.importedAt)} from {tracker.sourceName || tracker.sheetName}</span>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* A plain link, so the browser downloads it: the file is the point, not a fetch. */}
            <a
              href={`/api/trackers/${tracker.id}/export`}
              className="focus-ring inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-hairline text-[12.5px] text-fg-muted hover:text-fg hover:border-hairline-strong transition-colors"
            >
              <Download className="w-3.5 h-3.5" aria-hidden />
              Export .xlsx
            </a>
            <DeleteTracker id={tracker.id} name={tracker.name} rows={counts.rows} />
          </div>
        }
      />
      <p className="text-[12.5px] text-fg-muted m-0 max-w-[80ch]">
        Rows owned by other people are tracked here and stay out of your planner, your desk and your week. Exporting writes this back as an .xlsx
        with its original columns, plus an <span className="font-mono">SB ID</span> column so importing it again updates these rows instead of
        doubling them.
      </p>
        <TrackerTable rows={rows} />
      </div>
    </>
  );
}
