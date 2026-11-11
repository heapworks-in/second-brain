"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import type { ContainerRefDTO } from "@/lib/dto";
import type { TaskStatus } from "@/db/enums";
import { TRACKER_FIELDS, type Mapping, type TrackerField } from "@/domain/trackers/mapping";
import type { ImportPlan } from "@/domain/trackers/import";
import { Button, Chip } from "../ui";

const JSON_HEADERS = { "content-type": "application/json" };

interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
}

interface Parsed {
  sourceName: string;
  sheets: ParsedSheet[];
  sheetName: string;
  mapping: Mapping;
  statusMap: Record<string, TaskStatus>;
  identityNames: string[];
  plan: ImportPlan;
}

/** What each field is called where a person is choosing it, rather than where it is stored. */
const FIELD_LABELS: Record<TrackerField, string> = {
  theme: "Theme",
  task: "Task",
  subTask: "Sub-task",
  owner: "Owner",
  eta: "ETA",
  team: "Team",
  comments: "Comments",
  status: "Status",
};

const NONE = "—";

/**
 * Import a spreadsheet: choose the file, agree what its columns mean, then write it.
 *
 * Nothing is imported from the first screen. Every guess the app made is on show and changeable
 * -- which column is which, which status words mean finished, which names are me -- and the
 * counts underneath re-read the file each time one of them changes, so the number on the button
 * is always the number of rows that button will create.
 */
export function ImportCard({ containers }: { containers: ContainerRefDTO[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [name, setName] = useState("");
  const [containerId, setContainerId] = useState<number | null>(null);
  const [mapping, setMapping] = useState<Mapping>({ columns: {}, theme: "group" });
  const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
  const [mine, setMine] = useState<string[]>([]);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sheet = parsed?.sheets.find((s) => s.name === parsed.sheetName) ?? null;

  async function choose(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/trackers/parse", { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not read that file");
        return;
      }
      const next = body as Parsed;
      setParsed(next);
      setName(next.sheetName || next.sourceName.replace(/\.xlsx$/i, ""));
      setMapping(next.mapping);
      setStatusMap(next.statusMap);
      setMine(next.plan.people.filter((p) => p.isMe).map((p) => p.name));
      setPlan(next.plan);
    } finally {
      setBusy(false);
    }
  }

  /** Re-ask the server what the file means now, with nothing written. The plan on screen is
   * never a stale answer to an older mapping. */
  async function recheck(next: { mapping?: Mapping; statusMap?: Record<string, TaskStatus>; mine?: string[]; sheetName?: string }) {
    if (!parsed) return;
    const sheetName = next.sheetName ?? parsed.sheetName;
    const chosen = parsed.sheets.find((s) => s.name === sheetName);
    if (!chosen) return;
    const body = {
      name: name || sheetName,
      containerId,
      sourceName: parsed.sourceName,
      sheetName,
      headers: chosen.headers,
      rows: chosen.rows,
      mapping: next.mapping ?? mapping,
      statusMap: next.statusMap ?? statusMap,
      identityNames: next.mine ?? mine,
      dryRun: true,
    };
    const res = await fetch("/api/trackers", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    const answer = await res.json().catch(() => null);
    if (res.ok && answer?.plan) setPlan(answer.plan as ImportPlan);
  }

  function setColumn(field: TrackerField, header: string) {
    const columns = { ...mapping.columns };
    if (header === NONE) delete columns[field];
    else columns[field] = header;
    const next = { ...mapping, columns };
    setMapping(next);
    void recheck({ mapping: next });
  }

  function toggleMine(personName: string) {
    const next = mine.includes(personName) ? mine.filter((n) => n !== personName) : [...mine, personName];
    setMine(next);
    void recheck({ mine: next });
  }

  function setWord(word: string, lifecycle: TaskStatus | "open") {
    const next = { ...statusMap };
    if (lifecycle === "open") delete next[word];
    else next[word] = lifecycle;
    setStatusMap(next);
    void recheck({ statusMap: next });
  }

  async function run() {
    if (!parsed || !sheet) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/trackers", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          name: name || sheet.name,
          containerId,
          sourceName: parsed.sourceName,
          sheetName: sheet.name,
          headers: sheet.headers,
          rows: sheet.rows,
          mapping,
          statusMap,
          identityNames: mine,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not import that file");
        return;
      }
      router.push(`/trackers/${body.tracker.slug}`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!parsed) {
    return (
      <section className="pane p-5 flex flex-col gap-3">
        <h2 className="text-[15px] font-medium m-0">Import a spreadsheet</h2>
        <p className="text-[13px] text-fg-muted m-0 max-w-[62ch]">
          An .xlsx file with a header row: theme, task, sub-task, owner, ETA, team, comments, status. Columns it does not recognise are kept as they
          are and written back when you export. Nothing is imported until you have seen what it would do.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void choose(file);
            e.target.value = "";
          }}
        />
        <div className="flex items-center gap-3">
          <Button onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload className="w-3.5 h-3.5" aria-hidden />
            {busy ? "Reading…" : "Choose a file"}
          </Button>
          {error && <span className="text-danger text-[12.5px]">{error}</span>}
        </div>
      </section>
    );
  }

  const headers = sheet?.headers ?? [];
  const unknown = plan?.unknownStatuses ?? [];

  return (
    <section className="pane p-5 flex flex-col gap-5">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h2 className="text-[15px] font-medium m-0">{parsed.sourceName}</h2>
        <button type="button" className="focus-ring text-[12.5px] text-fg-muted hover:text-fg rounded-sm" onClick={() => setParsed(null)}>
          Choose a different file
        </button>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-[12.5px] text-fg-muted">
          Tracker name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="focus-ring h-9 px-2 rounded-md bg-layer-2 border border-hairline text-[13.5px] text-fg w-64"
          />
        </label>
        {parsed.sheets.length > 1 && (
          <label className="flex flex-col gap-1 text-[12.5px] text-fg-muted">
            Sheet
            <select
              value={parsed.sheetName}
              onChange={(e) => {
                setParsed({ ...parsed, sheetName: e.target.value });
                void recheck({ sheetName: e.target.value });
              }}
              className="focus-ring h-9 px-2 rounded-md bg-layer-2 border border-hairline text-[13.5px] text-fg"
            >
              {parsed.sheets.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.rows.length} rows)
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-[12.5px] text-fg-muted">
          File every row under
          <select
            value={containerId ?? ""}
            onChange={(e) => setContainerId(e.target.value ? Number(e.target.value) : null)}
            className="focus-ring h-9 px-2 rounded-md bg-layer-2 border border-hairline text-[13.5px] text-fg"
          >
            <option value="">No project</option>
            {containers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <span className="micro">Which column is which</span>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {TRACKER_FIELDS.map((field) => (
            <label key={field} className="flex flex-col gap-1 text-[12.5px] text-fg-muted min-w-0">
              {FIELD_LABELS[field]}
              <select
                value={mapping.columns[field] ?? NONE}
                onChange={(e) => setColumn(field, e.target.value)}
                className="focus-ring h-8 px-2 rounded-md bg-layer-2 border border-hairline text-[13px] text-fg min-w-0"
              >
                <option value={NONE}>{NONE} not in this file</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>

      {mapping.columns.theme && (
        <div className="flex flex-col gap-2">
          <span className="micro">The theme column is</span>
          <div className="flex gap-2 flex-wrap">
            {(["group", "container"] as const).map((mode) => (
              <Chip
                key={mode}
                active={mapping.theme === mode}
                onClick={() => {
                  const next = { ...mapping, theme: mode };
                  setMapping(next);
                  void recheck({ mapping: next });
                }}
              >
                {mode === "group" ? "A grouping on each row" : "The project each row belongs to"}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {plan && plan.people.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="micro">Which of these names are you</span>
          <div className="flex gap-2 flex-wrap">
            {plan.people.map((p) => (
              <Chip key={p.name} active={mine.includes(p.name)} onClick={() => toggleMine(p.name)} title={`${p.rows} row${p.rows === 1 ? "" : "s"}`}>
                {p.name}
                {p.personId === null && !mine.includes(p.name) && <span className="text-fg-faint ml-1.5">new</span>}
              </Chip>
            ))}
          </div>
          <p className="text-[12px] text-fg-faint m-0">
            Rows owned by anyone else are tracked here but stay out of your planner, your desk and your week.
          </p>
        </div>
      )}

      {unknown.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="micro">Status words this file uses</span>
          <div className="flex flex-col gap-1">
            {unknown.map((word) => (
              <label key={word} className="flex items-center gap-2 text-[13px]">
                <span className="w-40 truncate">{word}</span>
                <select
                  value={statusMap[word] ?? "open"}
                  onChange={(e) => setWord(word, e.target.value as TaskStatus)}
                  className="focus-ring h-8 px-2 rounded-md bg-layer-2 border border-hairline text-[13px] text-fg"
                >
                  <option value="open">still open</option>
                  <option value="done">finished</option>
                  <option value="dropped">not happening</option>
                </select>
              </label>
            ))}
          </div>
          <p className="text-[12px] text-fg-faint m-0">The word itself is kept either way, and written back when you export.</p>
        </div>
      )}

      {plan && (
        <div className="flex flex-col gap-2 border-t border-hairline pt-4">
          <span className="text-[13px]">
            {plan.counts.create} to create
            {plan.counts.update > 0 && `, ${plan.counts.update} to update`}
            {plan.counts.skip > 0 && `, ${plan.counts.skip} skipped`}
          </span>
          {plan.unparsedEtas.length > 0 && (
            <span className="text-[12.5px] text-warn">
              {plan.unparsedEtas.length} ETA{plan.unparsedEtas.length === 1 ? "" : "s"} are not dates (row {plan.unparsedEtas[0].row}: &ldquo;
              {plan.unparsedEtas[0].text}&rdquo;). They stay in the file as written and get no deadline here.
            </span>
          )}
          {plan.rows.some((r) => r.verdict === "skip") && (
            <span className="text-[12.5px] text-fg-muted">
              Skipped: {plan.rows.filter((r) => r.verdict === "skip").slice(0, 3).map((r) => `row ${r.row} (${r.reason})`).join(", ")}
            </span>
          )}
          {plan.keptColumns.length > 0 && <span className="text-[12.5px] text-fg-faint">Kept as they are: {plan.keptColumns.join(", ")}</span>}
          <p className="text-[12px] text-fg-faint m-0">Dates are read day first, so 03/04/2026 is 3 April.</p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={() => void run()} disabled={busy || !plan || plan.counts.create + plan.counts.update === 0}>
          {busy ? "Importing…" : `Import ${(plan?.counts.create ?? 0) + (plan?.counts.update ?? 0)} rows`}
        </Button>
        {error && <span className="text-danger text-[12.5px]">{error}</span>}
      </div>
    </section>
  );
}
