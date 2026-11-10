"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Users, Check, Plus } from "lucide-react";
import type { PersonDTO } from "@/lib/dto";
import { Button } from "./ui";

interface Props {
  selected: number[];
  onChange: (ids: number[]) => void;
  onClose: () => void;
  /** What the picker says it is choosing for. Defaults to the attendee case it was written for. */
  title?: string;
  /** One person, not a set: choosing closes the picker, because there is nothing left to say. */
  single?: boolean;
}

export function PeoplePicker({ selected, onChange, onClose, title = "People on this item", single }: Props) {
  const [all, setAll] = useState<PersonDTO[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => selected);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/people")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: PersonDTO[]) => {
        if (!cancelled) setAll(list);
      })
      .catch(() => {});
    inputRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const options = useMemo(() => (q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.slug.includes(q)) : all), [all, q]);
  const exact = options.some((p) => p.name.toLowerCase() === q);

  function toggle(id: number) {
    if (single) {
      setSelectedIds([id]);
      onChange([id]);
      onClose();
      return;
    }
    const next = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
    setSelectedIds(next);
    onChange(next);
  }

  async function create() {
    if (!q || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: query.trim() }) });
      if (res.ok) {
        const p = (await res.json()) as PersonDTO;
        setAll((a) => [...a, p]);
        const next = single ? [p.id] : [...selectedIds, p.id];
        setSelectedIds(next);
        onChange(next);
        setQuery("");
        if (single) onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[18vh]" onClick={onClose}>
      <div className="panel w-[480px] max-w-[92vw] rounded-lg overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 h-10 flex items-center gap-2 text-[13px] text-fg-muted border-b border-hairline">
          <Users className="w-4 h-4 text-fg-muted shrink-0" aria-hidden />
          {title}
        </div>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && q && !exact) {
              e.preventDefault();
              void create();
            }
          }}
          placeholder="Filter, or type a new name and press Enter"
          className="w-full h-11 px-4 bg-transparent border-b border-hairline outline-none text-[14px] focus:border-hairline-strong"
        />
        <ul className="max-h-72 overflow-y-auto py-1">
          {options.map((p) => {
            const linked = selectedIds.includes(p.id);
            return (
              <li
                key={p.id}
                onClick={() => toggle(p.id)}
                className="mx-1.5 px-2.5 h-10 rounded-md flex items-center gap-3 cursor-pointer hover:bg-layer-2"
              >
                <span className="w-6 h-6 rounded-full bg-layer-1 border border-hairline flex items-center justify-center text-[11px] text-fg-muted shrink-0">
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <span className={`flex-1 truncate text-[13.5px] ${linked ? "text-fg" : "text-fg-muted"}`}>{p.name}</span>
                <span className="font-mono text-[11px] text-fg-faint">{p.slug}</span>
                {linked && <Check className="w-3.5 h-3.5 text-violet-bright shrink-0" aria-hidden />}
              </li>
            );
          })}
          {q && !exact && (
            <li onClick={() => void create()} className="mx-1.5 px-2.5 h-10 rounded-md flex items-center gap-2 cursor-pointer text-violet-bright hover:bg-layer-2">
              <Plus className="w-3.5 h-3.5 shrink-0" aria-hidden />
              Create “{query.trim()}”
            </li>
          )}
          {options.length === 0 && !q && <li className="px-4 py-2 text-fg-faint text-[13px]">Nobody yet. Type a name.</li>}
        </ul>
        <div className="px-4 h-10 flex items-center justify-end border-t border-hairline">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
