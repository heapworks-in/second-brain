"use client";

import { SectionHeading } from "../ui";
import { CalendarFeed } from "../planner/calendar-feed";
import { ModelsSection, type ModelsPayload } from "./models-section";
import { FocusSection, MeetingsSection, PlannerSection, type MeetingSettings, type PlannerSettings } from "./simple-sections";
import type { FocusSettingsDTO } from "@/lib/dto";

export interface SettingsPayload {
  models: ModelsPayload;
  meetings: MeetingSettings;
  planner: PlannerSettings;
  focus: FocusSettingsDTO;
}

/**
 * Everything the app can be configured to do, in one place.
 *
 * Every section reads and writes **the route that already owns its setting**, so this page and
 * the controls that live where the work happens — the hours chip on the capacity line, the
 * rhythm switch in the focus pane — cannot disagree. There is no settings store and no copy of
 * one; those controls stay where they are deliberately, because making somebody leave the
 * Planner to change the hours the Planner is drawing would be a regression, and both of them
 * say so on the row.
 */
export function SettingsPage({ initial }: { initial: SettingsPayload }) {
  return (
    <div className="flex flex-col gap-4 max-w-[46rem]">
      <ModelsSection initial={initial.models} />

      <section className="pane p-4 flex flex-col gap-3" aria-label="Calendar">
        <SectionHeading>Calendar</SectionHeading>
        {/* The same component the Planner's gear used to hold, now with one home. */}
        <CalendarFeed />
      </section>

      <MeetingsSection initial={initial.meetings} />
      <PlannerSection initial={initial.planner} />
      <FocusSection initial={initial.focus} />
    </div>
  );
}
