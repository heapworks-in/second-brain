import Link from "next/link";
import { Table } from "lucide-react";
import { getDb } from "@/db/client";
import { Crumb } from "@/components/shell/crumb";
import { listContainers } from "@/domain/containers";
import { listTrackers } from "@/domain/trackers/export";
import { ImportCard } from "@/components/trackers/import-card";
import { EmptyState, PageHeader } from "@/components/ui";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function TrackersPage() {
  const db = getDb();
  const trackers = listTrackers(db);
  const containers = listContainers(db, { status: "active" }).map((c) => ({ id: c.id, name: c.name, slug: c.slug, kind: c.kind }));
  return (
    <>
      <Crumb title="Trackers" />
      <div className="w-full px-6 lg:px-8 pt-8 flex flex-col gap-5">
      <PageHeader
        title="Trackers"
        meta={
          <>
            <span>A team&rsquo;s spreadsheet, held here and handed back.</span>{" "}
            <span className="font-mono">
              {trackers.length} tracker{trackers.length === 1 ? "" : "s"}
            </span>
          </>
        }
      />
      <ImportCard containers={containers} />
      {trackers.length === 0 ? (
        <EmptyState icon={Table} text="No trackers yet. Import an .xlsx file above and it keeps its columns." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {trackers.map((t) => (
            <Link
              key={t.id}
              href={`/trackers/${t.slug}`}
              className="focus-ring pane flex flex-col gap-3 p-5 transition-all duration-150 hover:border-hairline-strong motion-safe:hover:-translate-y-0.5"
            >
              <div className="min-w-0">
                <div className="text-[15px] font-medium leading-5 truncate">{t.name}</div>
                <div className="font-mono text-[11px] text-fg-faint truncate">{t.sourceName || t.sheetName}</div>
              </div>
              <div className="border-t border-hairline pt-3 flex flex-col gap-1 text-[13px]">
                <span className="text-fg-muted">
                  {t.counts.rows} rows · {t.counts.done} done
                </span>
                <span className={t.counts.mine > 0 ? "text-violet-bright" : "text-fg-faint"}>
                  {t.counts.mine > 0 ? `${t.counts.mine} yours` : "None of it yours"}
                </span>
                <span className="text-fg-faint font-mono text-[11px]">Imported {formatDate(t.importedAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      </div>
    </>
  );
}
