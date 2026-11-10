"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Plus } from "lucide-react";
import type { PlannerDayDTO, TaskDTO } from "@/lib/dto";
import { quickParse } from "@/domain/tasks/quick-parse";
import { formatMinutes } from "@/lib/capacity";
import { Chip } from "../ui";
import { formatShortDate } from "../tasks/task-row";

const JSON_HEADERS = { "content-type": "application/json" };
/** Before anything is typed, the list offers this many suggestions at most. */
const SUGGESTION_CAP = 8;
/** A search shows this many matches at most; a longer list is a narrower search away. */
const MATCH_CAP = 20;

export type PickerFilter = "owed" | "due" | "inbox" | "projects" | "areas";
const FILTERS: { id: PickerFilter; label: string }[] = [
  // First, and before "Due", because somebody else's wait outranks my own dates.
  { id: "owed", label: "Owed" },
  { id: "due", label: "Due" },
  { id: "inbox", label: "Inbox" },
  { id: "projects", label: "Projects" },
  { id: "areas", label: "Areas" },
];

interface Option {
  id: string;
  task?: TaskDTO;
  /** The typed text, when the option is to make a task of it. */
  create?: string;
}
interface Group {
  key: string;
  label: string;
  options: Option[];
}

interface Props {
  day: PlannerDayDTO;
  today: string;
}

/**
 * The one way tasks reach the plan from inside it: a field that searches every open task, or
 * makes a new one of what was typed. Before anything is typed it suggests what is due and what
 * yesterday left; the chips browse one home at a time. The list opens under the field and
 * pushes the pane down rather than covering anything, and closes on Escape or a click away.
 */
export function PlanPicker({ day, today }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<PickerFilter | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busy = useRef(false);
  const listId = useId();

  const groups = useMemo<Group[]>(() => {
    const { sources } = day;
    const plannedIds = new Set(day.plan.map((t) => t.id));
    const unplanned = (list: TaskDTO[]) => list.filter((t) => !plannedIds.has(t.id));
    const q = query.trim().toLowerCase();
    const homes: { key: string; label: string; tasks: TaskDTO[] }[] = [
      { key: "owed", label: "Owed", tasks: unplanned(sources.owed) },
      { key: "inbox", label: "Inbox", tasks: unplanned(sources.inbox) },
      ...sources.projects.map((g) => ({ key: `project-${g.container.id}`, label: g.container.name, tasks: unplanned(g.tasks) })),
      ...sources.areas.map((g) => ({ key: `area-${g.container.id}`, label: g.container.name, tasks: unplanned(g.tasks) })),
    ];
    const toGroup = (key: string, label: string, tasks: TaskDTO[]): Group => ({ key, label, options: tasks.map((t) => ({ id: `task-${t.id}`, task: t })) });
    if (q) {
      const hits = homes.map((h) => ({ ...h, tasks: h.tasks.filter((t) => t.title.toLowerCase().includes(q)) })).filter((h) => h.tasks.length > 0);
      let left = MATCH_CAP;
      const out: Group[] = [];
      for (const h of hits) {
        if (left <= 0) break;
        out.push(toGroup(h.key, h.label, h.tasks.slice(0, left)));
        left -= h.tasks.length;
      }
      // Only what can become a task: "~15m" alone has no title to give it.
      if (quickParse(query.trim()).title) out.push({ key: "new", label: "New", options: [{ id: "create", create: query.trim() }] });
      return out;
    }
    switch (filter) {
      case "owed":
        return [toGroup("owed", "Owed", unplanned(sources.owed))];
      case "due":
        return [toGroup("due", "Due", unplanned([...sources.due.overdue, ...sources.due.today]))];
      case "inbox":
        return [toGroup("inbox", "Inbox", unplanned(sources.inbox))];
      case "projects":
        return sources.projects.map((g) => toGroup(`project-${g.container.id}`, g.container.name, unplanned(g.tasks)));
      case "areas":
        return sources.areas.map((g) => toGroup(`area-${g.container.id}`, g.container.name, unplanned(g.tasks)));
      default: {
        // Owed leads: these are the only suggestions whose cost of waiting another day is
        // somebody else's. Each list then drops what an earlier one already offered, so a task
        // somebody is waiting on that is also overdue is named once, at the top.
        const owed = unplanned(sources.owed).slice(0, SUGGESTION_CAP);
        const seen = new Set(owed.map((t) => t.id));
        const due = unplanned([...sources.due.overdue, ...sources.due.today].filter((t) => !seen.has(t.id))).slice(0, Math.max(0, SUGGESTION_CAP - owed.length));
        for (const t of due) seen.add(t.id);
        const left = unplanned(day.unfinishedYesterday.filter((t) => !seen.has(t.id))).slice(0, Math.max(0, SUGGESTION_CAP - owed.length - due.length));
        return [
          ...(owed.length ? [toGroup("owed", "Owed", owed)] : []),
          ...(due.length ? [toGroup("due", "Due", due)] : []),
          ...(left.length ? [toGroup("yesterday", "From yesterday", left)] : []),
        ];
      }
    }
  }, [day, query, filter]);

  const options = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const current = options[Math.min(active, Math.max(0, options.length - 1))];

  // A click away closes the list; the field keeps whatever was typed.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Arrowing past the visible rows brings the active one into view.
  useEffect(() => {
    if (!open || !current) return;
    document.getElementById(`${listId}-${current.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, current, listId]);

  // The ritual's "Open projects" and the ⌘/ key land here.
  useEffect(() => {
    function onAsk(e: Event) {
      const detail = (e as CustomEvent<{ filter?: PickerFilter; focus?: boolean }>).detail ?? {};
      if (detail.filter) setFilter(detail.filter);
      setOpen(true);
      setActive(0);
      if (detail.focus !== false) inputRef.current?.focus();
    }
    window.addEventListener("sb:plan-picker", onAsk);
    return () => window.removeEventListener("sb:plan-picker", onAsk);
  }, []);

  async function post(url: string, body: unknown): Promise<Response> {
    return fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  }

  /** Puts a task on the plan, or makes one first; the field empties and stays ready for the next. */
  async function choose(option: Option | undefined, close = false) {
    // A second Enter while the first is still on its way would make the task twice.
    if (!option || busy.current) return;
    busy.current = true;
    try {
      let taskId = option.task?.id;
      let made = false;
      if (option.create) {
        const parsed = quickParse(option.create);
        const body: Record<string, unknown> = { title: parsed.title, priority: parsed.priority, dueDate: parsed.dueDate };
        if (parsed.estimateMinutes !== null) body.estimateMinutes = parsed.estimateMinutes;
        if (parsed.sessionMinutes !== null) body.sessionMinutes = parsed.sessionMinutes;
        if (parsed.requesterHandle) body.requesterHandle = parsed.requesterHandle;
        const res = await post("/api/tasks", body);
        if (!res.ok) throw new Error("create");
        taskId = ((await res.json()) as { id: number }).id;
        made = true;
      }
      const planned = await post("/api/plan", { date: day.date, taskId });
      if (!planned.ok) throw new Error("plan");
      setError(null);
      setQuery("");
      setActive(0);
      // One announcement each, once the whole move is done, so the day is read back once.
      if (made) window.dispatchEvent(new Event("sb:tasks-changed"));
      window.dispatchEvent(new Event("sb:plan-changed"));
      if (close) setOpen(false);
      else inputRef.current?.focus();
    } catch {
      setError("Could not add that to the plan");
    } finally {
      busy.current = false;
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const n = options.length;
      if (n === 0) return;
      setActive((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!open && !query.trim()) {
        setOpen(true);
        return;
      }
      void choose(current ?? (query.trim() ? { id: "create", create: query.trim() } : undefined), e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  }

  const dayWord = day.date === today ? "today" : formatShortDate(day.date);
  const emptyLine = query.trim()
    ? null
    : filter === null
      ? "Nothing due and nothing left from yesterday. Pick a home, or type to search or create."
      : "Nothing left to plan here.";

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Plus className="w-4 h-4 text-fg-faint shrink-0" aria-hidden />
        <input
          ref={inputRef}
          role="combobox"
          aria-label={`Add a task for ${dayWord}`}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && current ? `${listId}-${current.id}` : undefined}
          placeholder="Add a task: type to search, or create"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKey}
          className="focus-ring flex-1 min-w-0 h-9 px-2 rounded-md bg-layer-2 border border-hairline text-[13.5px] text-fg placeholder:text-fg-faint"
        />
      </div>
      {open && (
        <>
          <div className="flex items-center gap-1 flex-wrap" role="group" aria-label="Browse">
            {FILTERS.map((f) => (
              <Chip
                key={f.id}
                aria-pressed={filter === f.id}
                active={filter === f.id}
                onClick={() => {
                  setFilter((v) => (v === f.id ? null : f.id));
                  setActive(0);
                  inputRef.current?.focus();
                }}
              >
                {f.label}
              </Chip>
            ))}
          </div>
          {options.length === 0 && emptyLine && <p className="text-[13px] text-fg-faint m-0 px-1">{emptyLine}</p>}
          <div id={listId} role="listbox" aria-label="Tasks to plan" className="flex flex-col gap-2 max-h-80 overflow-y-auto">
            {groups
              .filter((g) => g.options.length > 0)
              .map((g) => (
                <div key={g.key} role="group" aria-label={g.label} className="flex flex-col">
                  <span className="micro px-1 py-1">{g.label}</span>
                  {g.options.map((o) => {
                    const selected = current?.id === o.id;
                    return (
                      <div
                        key={o.id}
                        id={`${listId}-${o.id}`}
                        role="option"
                        aria-selected={selected}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => void choose(o, e.metaKey || e.ctrlKey)}
                        className={`flex items-center gap-2 h-9 px-2 rounded-md cursor-pointer text-[13.5px] ${selected ? "bg-layer-2 text-fg" : "text-fg-muted hover:text-fg hover:bg-layer-2"}`}
                      >
                        {o.create ? (
                          <>
                            <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden />
                            <span className="truncate">Create &ldquo;{o.create}&rdquo;</span>
                          </>
                        ) : (
                          <>
                            <span className="flex-1 min-w-0 truncate">{o.task!.title}</span>
                            {o.task!.dueDate && <span className="font-mono text-[11px] text-fg-faint shrink-0">{formatShortDate(o.task!.dueDate)}</span>}
                            {o.task!.estimateMinutes !== null && <span className="font-mono text-[11px] text-fg-faint shrink-0">{formatMinutes(o.task!.estimateMinutes)}</span>}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
          </div>
        </>
      )}
      {error && <p className="text-danger text-[12.5px] m-0">{error}</p>}
    </div>
  );
}
