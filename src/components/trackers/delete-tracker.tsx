"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "../ui";

/**
 * Two ways to remove a tracker, because both are things people mean.
 *
 * "Keep the rows" is the sheet having been only how the work arrived; "delete them too" is a
 * file imported by mistake. Each says what it does to the rows before it is pressed, and the
 * destructive one says how many and that it cannot be undone.
 */
export function DeleteTracker({ id, name, rows }: { id: number; name: string; rows: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(mode: "keep" | "delete") {
    setBusy(true);
    try {
      const res = await fetch(`/api/trackers/${id}?rows=${mode}`, { method: "DELETE" });
      if (!res.ok) {
        setError("Could not remove that tracker");
        return;
      }
      router.push("/trackers");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-hairline text-[12.5px] text-fg-muted hover:text-danger hover:border-danger/40 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" aria-hidden />
        Remove
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[12.5px] text-fg-muted">Remove {name}?</span>
      <Button size="sm" variant="ghost" onClick={() => void remove("keep")} disabled={busy}>
        Keep the {rows} rows as tasks
      </Button>
      <Button size="sm" variant="ghost" className="text-danger" onClick={() => void remove("delete")} disabled={busy}>
        Delete the {rows} rows too
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </Button>
      {error && <span className="text-danger text-[12.5px]">{error}</span>}
    </div>
  );
}
