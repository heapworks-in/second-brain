"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Button, Input, SectionHeading } from "../ui";

/**
 * The names that mean me in somebody else's spreadsheet.
 *
 * The app has never needed to know who I am: my own work is a row with no owner, which cannot
 * be mistyped. A file is the exception -- it names me in an Owner column, in whatever form the
 * person who built it used -- so this is the one place the app holds my own name, and it holds
 * it as a list because "Avinash", "Avinash V" and "AV" are all me in three different trackers.
 *
 * The import asks for this the first time; it lives here so it can be corrected without
 * importing anything, and so a name added later applies to the next file by itself.
 */
export function IdentitySection({ initial }: { initial: string[] }) {
  const [names, setNames] = useState(initial);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: string[]) {
    const previous = names;
    setNames(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/identity", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ names: next }) });
      if (!res.ok) {
        setNames(previous);
        setError("That did not save");
        return;
      }
      setNames(((await res.json()) as { names: string[] }).names);
    } catch {
      setNames(previous);
      setError("That did not save");
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const name = draft.trim();
    if (!name || names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      setDraft("");
      return;
    }
    setDraft("");
    void save([...names, name]);
  }

  return (
    <section className="pane p-4 flex flex-col gap-3" aria-label="You">
      <SectionHeading>You</SectionHeading>
      <p className="text-[12.5px] text-fg-muted m-0">
        How your name is spelled in the Owner column of a tracker. Rows naming one of these are yours; every other row is tracked but stays out of
        your planner, your desk and your week.
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        {names.map((name) => (
          <span key={name} className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-full border border-hairline text-[12px]">
            {name}
            <button
              type="button"
              aria-label={`Remove ${name}`}
              disabled={busy}
              onClick={() => void save(names.filter((n) => n !== name))}
              className="focus-ring rounded-full p-0.5 text-fg-faint hover:text-danger transition-colors"
            >
              <X className="w-3 h-3" aria-hidden />
            </button>
          </span>
        ))}
        {names.length === 0 && <span className="text-[12.5px] text-fg-faint">No names yet. The first import will ask.</span>}
      </div>
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          value={draft}
          placeholder="Add a spelling"
          aria-label="Add a spelling of your name"
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className="w-56"
        />
        <Button size="sm" variant="ghost" onClick={add} disabled={busy || !draft.trim()}>
          Add
        </Button>
        {error && <span className="text-danger text-[12.5px]">{error}</span>}
      </div>
    </section>
  );
}
