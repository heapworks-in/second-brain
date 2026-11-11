"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TrackerRowDTO } from "@/lib/dto";
import type { TaskStatus } from "@/db/enums";
import { deadlineLabel, TONE_CLASS } from "@/lib/deadline";
import { Chip } from "../ui";

const JSON_HEADERS = { "content-type": "application/json" };

/** The word to write beside a lifecycle when a row has none of its own. */
const FALLBACK: Record<TaskStatus, string> = { open: "Not started", done: "Done", dropped: "Dropped" };

/**
 * A tracker as its sheet reads: grouped by theme, then by the task its sub-tasks sit under.
 *
 * Rows that belong to other people are here to be *seen* -- that is the whole point of holding
 * the team's sheet -- and the only thing this page offers on one is to take it over, because
 * that is the only honest thing I can do about somebody else's work. My own rows can be
 * finished here, which writes the word the team reads back into the file.
 */
export function TrackerTable({ rows: initial }: { rows: TrackerRowDTO[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  async function patch(id: number, body: Record<string, unknown>) {
    const res = await fetch(`/api/tasks/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
    if (!res.ok) {
      setError("Could not save that change");
      return;
    }
    setError(null);
    router.refresh();
  }

  function complete(row: TrackerRowDTO) {
    const next: TaskStatus = row.status === "done" ? "open" : "done";
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: next, statusLabel: next === "done" ? "Done" : "In Progress" } : r)));
    void patch(row.id, { status: next });
  }

  function takeOver(row: TrackerRowDTO) {
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, owner: null, mine: true } : r)));
    void patch(row.id, { ownerPersonId: null });
  }

  // Themes in the order the file had them, and the parent label inside each: the sheet's own
  // shape, rebuilt from the rows rather than stored as a tree.
  const themes: { theme: string; groups: { label: string; rows: TrackerRowDTO[] }[] }[] = [];
  for (const row of rows) {
    let theme = themes.find((t) => t.theme === row.theme);
    if (!theme) {
      theme = { theme: row.theme, groups: [] };
      themes.push(theme);
    }
    let group = theme.groups.find((g) => g.label === row.parentLabel);
    if (!group) {
      group = { label: row.parentLabel, rows: [] };
      theme.groups.push(group);
    }
    group.rows.push(row);
  }

  function row(r: TrackerRowDTO) {
    const due = r.dueDate ? deadlineLabel(r.dueDate, today) : null;
    return (
      <li key={r.id} className={`hairline-row flex items-center gap-3 px-3 h-10 min-w-0 ${r.status === "done" ? "opacity-60" : ""}`}>
        <input
          type="checkbox"
          checked={r.status === "done"}
          disabled={!r.mine}
          onChange={() => complete(r)}
          aria-label={r.mine ? `Finish ${r.title}` : `${r.title} is not yours to finish`}
          className="shrink-0 accent-violet disabled:opacity-30"
          title={r.mine ? undefined : "Take it over first"}
        />
        <span className={`flex-1 truncate text-[13.5px] ${r.status === "done" ? "line-through" : ""}`}>{r.title}</span>
        {r.notes && (
          <span className="hidden lg:block w-56 truncate text-[12px] text-fg-faint" title={r.notes}>
            {r.notes}
          </span>
        )}
        <span className="w-28 truncate text-[12px] text-fg-muted">
          {r.owner ? (
            <Link href={`/people/${r.owner.slug}`} className="focus-ring hover:text-violet-bright rounded-sm">
              {r.owner.name}
            </Link>
          ) : (
            "You"
          )}
        </span>
        <span className={`w-20 font-mono text-[11px] shrink-0 ${due ? TONE_CLASS[due.tone] : "text-fg-faint"}`}>
          {r.dueDate ? r.dueDate.slice(5) : r.etaText}
        </span>
        <span className="w-24 truncate text-[12px] text-fg-muted shrink-0">{r.statusLabel || FALLBACK[r.status]}</span>
        <span className="w-20 shrink-0 text-right">
          {!r.mine && (
            <button type="button" onClick={() => takeOver(r)} className="focus-ring text-[12px] text-fg-faint hover:text-violet-bright rounded-sm">
              Take over
            </button>
          )}
        </span>
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {themes.map((theme) => (
        <section key={theme.theme || "—"} className="flex flex-col gap-2">
          {theme.theme && (
            <div className="flex items-baseline gap-2">
              <h3 className="text-[13px] font-medium m-0">{theme.theme}</h3>
              <span className="micro">{theme.groups.reduce((n, g) => n + g.rows.length, 0)}</span>
            </div>
          )}
          <div className="pane overflow-hidden">
            {theme.groups.map((group) => (
              <div key={group.label || "—"}>
                {group.label && (
                  <div className="px-3 pt-2.5 pb-1 flex items-center gap-2">
                    <span className="text-[12.5px] text-fg-muted">{group.label}</span>
                    <span className="flex-1 border-t border-hairline" />
                  </div>
                )}
                <ul role="list" className="list-none m-0 p-0">{group.rows.map(row)}</ul>
              </div>
            ))}
          </div>
        </section>
      ))}
      {rows.length === 0 && (
        <p className="text-[13px] text-fg-faint m-0">
          Nothing in this tracker. Import the file again to fill it, or <Chip href="/trackers">pick another</Chip>.
        </p>
      )}
      {error && <p className="text-danger text-[12.5px] m-0">{error}</p>}
    </div>
  );
}
