"use client";

import { useCallback, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button, Input, Select, SectionHeading } from "../ui";
import type { FocusSettingsDTO } from "@/lib/dto";

const DAYS = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

/**
 * The shared shape of a settings section: read what the route answered, PATCH one field at a
 * time, and keep the previous value on screen when a save fails.
 *
 * One field at a time rather than a form with a Save button, because every one of these routes
 * already takes a partial patch, and a Save button invents a draft state that can disagree with
 * what is stored. The cost is that a failure has to be visible — hence `error` below, which
 * every section shows in the same place.
 */
function useSection<T>(url: string, initial: T) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = useCallback(
    async (body: Partial<Record<keyof T & string, unknown>>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const next = (await res.json()) as T & { error?: string };
        // The previous value stays on screen on failure: a control that silently snapped back to
        // what was stored would look like the save worked and then undid itself.
        if (!res.ok) setError(next.error ?? "That did not save");
        else setValue(next);
      } catch {
        setError("That did not save");
      } finally {
        setBusy(false);
      }
    },
    [url],
  );

  return { value, busy, error, patch };
}

/** A labelled row, so every section lines its controls up the same way. */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-t border-hairline pt-3 first:border-0 first:pt-0">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[13px]">{label}</span>
        <span className="flex-1" />
        {children}
      </div>
      {hint && <span className="text-[12px] text-fg-faint">{hint}</span>}
    </div>
  );
}

function Problem({ error }: { error: string | null }) {
  return error ? <p className="m-0 text-[12.5px] text-danger">{error}</p> : null;
}

export interface MeetingSettings {
  autoRecord: boolean;
  autoRecordNeedsCallLink: boolean;
  audioRetentionDays: number | null;
}

const MEETING_DEFAULTS: MeetingSettings = { autoRecord: false, autoRecordNeedsCallLink: true, audioRetentionDays: null };

export function MeetingsSection({ initial }: { initial: MeetingSettings }) {
  const { value, busy, error, patch } = useSection("/api/settings/meetings", initial);
  return (
    <section className="pane p-4 flex flex-col gap-3" aria-label="Meetings">
      <div className="flex items-baseline gap-3">
        <SectionHeading>Meetings</SectionHeading>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={RotateCcw} disabled={busy} onClick={() => void patch(MEETING_DEFAULTS)}>
          Reset
        </Button>
      </div>
      <Field label="Record meetings automatically" hint="Off by default. Nothing is recorded unless you ask for it.">
        <input
          type="checkbox"
          aria-label="Record meetings automatically"
          checked={value.autoRecord}
          disabled={busy}
          onChange={(e) => void patch({ autoRecord: e.target.checked })}
        />
      </Field>
      <Field label="Only meetings with a call link" hint="A meeting with no link is usually a hold or a reminder, not a conversation.">
        <input
          type="checkbox"
          aria-label="Only meetings with a call link"
          checked={value.autoRecordNeedsCallLink}
          disabled={busy || !value.autoRecord}
          onChange={(e) => void patch({ autoRecordNeedsCallLink: e.target.checked })}
        />
      </Field>
      <Field
        label="Keep the audio for"
        hint="The transcript is the record; the audio is scaffolding. Keeping it for ever is the default because deleting somebody's recording is not a thing to do by surprise."
      >
        <Select
          size="sm"
          aria-label="Keep the audio for"
          disabled={busy}
          value={value.audioRetentionDays === null ? "" : String(value.audioRetentionDays)}
          onChange={(e) => void patch({ audioRetentionDays: e.target.value === "" ? null : Number(e.target.value) })}
        >
          <option value="">For ever</option>
          <option value="0">Until the transcript is written</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">A year</option>
        </Select>
      </Field>
      <Problem error={error} />
    </section>
  );
}

export interface PlannerSettings {
  workHours: string;
  workingDays: number[];
}

const PLANNER_DEFAULTS: PlannerSettings = { workHours: "09:00-17:30", workingDays: [1, 2, 3, 4, 5] };

export function PlannerSection({ initial }: { initial: PlannerSettings }) {
  const { value, busy, error, patch } = useSection("/api/settings/planner", initial);
  const [hours, setHours] = useState(initial.workHours);
  return (
    <section className="pane p-4 flex flex-col gap-3" aria-label="Planner">
      <div className="flex items-baseline gap-3">
        <SectionHeading>Planner</SectionHeading>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          icon={RotateCcw}
          disabled={busy}
          onClick={() => {
            setHours(PLANNER_DEFAULTS.workHours);
            void patch(PLANNER_DEFAULTS);
          }}
        >
          Reset to 09:00-17:30, Mon–Fri
        </Button>
      </div>
      <Field label="Working hours" hint="What the capacity line counts down from. Also changeable on the day itself, from the chip on that line.">
        <Input
          size="sm"
          aria-label="Working hours"
          className="w-[11ch] font-mono"
          value={hours}
          disabled={busy}
          onChange={(e) => setHours(e.target.value)}
          onBlur={() => hours !== value.workHours && void patch({ workHours: hours })}
        />
      </Field>
      <Field label="Working days" hint="Days the planner draws a capacity line for at all.">
        <span className="flex items-center gap-1">
          {DAYS.map((d) => {
            const on = value.workingDays.includes(d.n);
            return (
              <button
                key={d.n}
                type="button"
                aria-label={d.label}
                aria-pressed={on}
                disabled={busy}
                onClick={() => void patch({ workingDays: on ? value.workingDays.filter((x) => x !== d.n) : [...value.workingDays, d.n] })}
                className={`focus-ring rounded-sm h-6 px-2 text-[11.5px] ${on ? "bg-violet-dim text-fg" : "text-fg-faint hover:text-fg hover:bg-layer-2"}`}
              >
                {d.label}
              </button>
            );
          })}
        </span>
      </Field>
      <Problem error={error} />
    </section>
  );
}

const FOCUS_DEFAULTS = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" as const };

export function FocusSection({ initial }: { initial: FocusSettingsDTO }) {
  const { value, busy, error, patch } = useSection("/api/settings/focus", initial);
  const number = (label: string, key: "defaultMinutes" | "shortBreak" | "longBreak" | "longBreakEvery", hint: string, max: number) => (
    <Field label={label} hint={hint}>
      <Input
        size="sm"
        type="number"
        min={1}
        max={max}
        aria-label={label}
        className="w-[7ch] font-mono"
        value={value[key]}
        disabled={busy}
        onChange={(e) => void patch({ [key]: Number(e.target.value) })}
      />
    </Field>
  );
  return (
    <section className="pane p-4 flex flex-col gap-3" aria-label="Focus">
      <div className="flex items-baseline gap-3">
        <SectionHeading>Focus</SectionHeading>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={RotateCcw} disabled={busy} onClick={() => void patch(FOCUS_DEFAULTS)}>
          Reset to 25/5/15
        </Button>
      </div>
      <Field label="Rhythm" hint="Also switchable in the focus pane while you work. A pomodoro has a break after it; a timebox ends in a decision.">
        <Select size="sm" aria-label="Rhythm" disabled={busy} value={value.mode} onChange={(e) => void patch({ mode: e.target.value })}>
          <option value="pomodoro">Pomodoro</option>
          <option value="timebox">Timebox</option>
        </Select>
      </Field>
      {number("Default length", "defaultMinutes", "Minutes a run lasts when you do not choose.", 240)}
      {number("Short break", "shortBreak", "Minutes offered after a pomodoro.", 60)}
      {number("Long break", "longBreak", "Minutes offered at the end of a cycle.", 120)}
      {number("Pomodoros before a long break", "longBreakEvery", "The dots in the focus pane count this out.", 12)}
      <Problem error={error} />
    </section>
  );
}
