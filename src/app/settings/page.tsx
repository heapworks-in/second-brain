import { getDb } from "@/db/client";
import { Crumb } from "@/components/shell/crumb";
import { PageHeader } from "@/components/ui";
import { SettingsPage } from "@/components/settings/settings-page";
import { getFocusSettings } from "@/domain/focus";
import { getAutoRecordSettings } from "@/domain/meetings/auto-start";
import { audioRetentionDays } from "@/domain/meetings/audio-retention";
import { ROLE_LABELS, hasBackup } from "@/domain/models/config";
import { roleStates } from "@/domain/models/resolve";
import { getWorkHours, getWorkingDays } from "@/lib/work-hours";

export const dynamic = "force-dynamic";

/**
 * Assembled on the server so the page opens with its real state rather than a column of
 * spinners. The model rows are the one part that costs a round trip — the runtime is asked
 * whether it is there — and it is asked once here for every row.
 */
export default async function Settings() {
  const db = getDb();
  const { states, runtime, configError, url } = await roleStates();
  return (
    <>
      <Crumb title="Settings" />
      <div className="w-full max-w-3xl mx-auto px-6 lg:px-8 pt-8 pb-16 flex flex-col gap-4">
        <PageHeader title="Settings" meta="What this app is configured to do, and what it needs installed to do it." />
        <SettingsPage
          initial={{
            models: {
              url,
              runtime: { reachable: runtime.reachable, version: runtime.version, error: runtime.error, models: runtime.models },
              configError,
              canRevert: hasBackup(),
              roles: states.map((s) => ({ ...s, ...ROLE_LABELS[s.role] })),
            },
            meetings: { ...getAutoRecordSettings(db), audioRetentionDays: audioRetentionDays(db) },
            planner: { workHours: getWorkHours(db), workingDays: getWorkingDays(db) },
            focus: getFocusSettings(db),
          }}
        />
      </div>
    </>
  );
}
