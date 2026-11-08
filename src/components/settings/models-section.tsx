"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button, Select, SectionHeading } from "../ui";
import { formatBytes } from "@/lib/format";

interface RoleRow {
  role: string;
  title: string;
  what: string;
  source: "config" | "runtime" | "local" | "none";
  model: string | null;
  wanted: string | null;
  unavailable: string | null;
}

export interface ModelsPayload {
  url: string;
  runtime: { reachable: boolean; version: string | null; error: string | null; models: { name: string; size: number }[] };
  configError: string | null;
  canRevert: boolean;
  roles: RoleRow[];
}

/** Where the answer came from, in words rather than a word from the code. */
const SOURCE_WORDS: Record<RoleRow["source"], string> = {
  config: "chosen here",
  runtime: "the only model your runtime holds",
  local: "the copy installed beside the app",
  none: "nothing yet",
};

/**
 * Which local model plays which role.
 *
 * The models offered come from the runtime rather than from a text field, because typing a model
 * you have not pulled is the obvious way to break this and a list of what you actually have
 * removes it entirely. Each row says which of the three sources is answering it, so "why is this
 * summary not being written" has an answer on screen instead of in a log.
 */
export function ModelsSection({ initial }: { initial: ModelsPayload }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async (method: "PATCH" | "DELETE", body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/models", {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const next = (await res.json()) as ModelsPayload & { error?: string };
      if (!res.ok) {
        setError(next.error ?? "That did not go through");
        return;
      }
      setData(next);
    } catch {
      setError("That did not go through");
    } finally {
      setBusy(false);
    }
  }, []);

  // Re-read on return to the page: the runtime can be started or stopped behind the app's back,
  // and a row claiming a model is missing when it is no longer missing is worse than no row.
  useEffect(() => {
    function onFocus() {
      void (async () => {
        const res = await fetch("/api/settings/models", { cache: "no-store" }).catch(() => null);
        if (res?.ok) setData((await res.json()) as ModelsPayload);
      })();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return (
    <section className="pane p-4 flex flex-col gap-3" aria-label="Models">
      <div className="flex items-baseline gap-3 flex-wrap">
        <SectionHeading>Models</SectionHeading>
        <span className="flex-1" />
        {data.canRevert && (
          <Button size="sm" variant="ghost" icon={RotateCcw} disabled={busy} onClick={() => void send("DELETE")}>
            Undo the last change
          </Button>
        )}
      </div>

      <p className="m-0 text-[12px] text-fg-faint">
        Kept in <code className="font-mono">~/.config/local-models.json</code>, outside this app, so other tools can read the same answer.
      </p>

      {/* The runtime's own row: reachable, or what to do about it. Never just "not reachable". */}
      <p className="m-0 text-[12.5px]" role="status">
        {data.runtime.reachable ? (
          <span className="text-fg-muted">
            Runtime: ollama {data.runtime.version} at <code className="font-mono">{data.url}</code> — {data.runtime.models.length}{" "}
            {data.runtime.models.length === 1 ? "model" : "models"}
          </span>
        ) : (
          <span className="text-fg-muted">
            No runtime at <code className="font-mono">{data.url}</code>. Roles fall back to a model installed beside the app. To use one:{" "}
            <code className="font-mono">brew install ollama</code>, then <code className="font-mono">ollama serve</code>.
          </span>
        )}
      </p>

      {data.configError && (
        <p className="m-0 flex items-start gap-2 text-[12.5px] text-danger">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
          <span>The file could not be read, so nothing in it is in force: {data.configError}</span>
        </p>
      )}

      <ul className="list-none m-0 p-0 flex flex-col gap-3">
        {data.roles.map((role) => (
          <li key={role.role} className="flex flex-col gap-1 border-t border-hairline pt-3 first:border-0 first:pt-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px]">{role.title}</span>
              <span className="flex-1" />
              <Select
                size="sm"
                aria-label={`Model for ${role.title}`}
                disabled={busy || !data.runtime.reachable}
                value={role.wanted ?? ""}
                onChange={(e) => void send("PATCH", { role: role.role, model: e.target.value === "" ? null : e.target.value })}
              >
                <option value="">Decide automatically</option>
                {data.runtime.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} · {formatBytes(m.size)}
                  </option>
                ))}
                {/* A model the file names but the runtime no longer has still shows, selected:
                    silently dropping it would make the row read as never configured. */}
                {role.wanted && !data.runtime.models.some((m) => m.name === role.wanted) && (
                  <option value={role.wanted}>{role.wanted} · not installed</option>
                )}
              </Select>
            </div>
            <span className="text-[12px] text-fg-faint">{role.what}</span>
            {role.unavailable ? (
              <span className="text-[12px] text-danger">{role.unavailable}</span>
            ) : (
              <span className="text-[12px] text-fg-muted">
                Using {role.source === "local" ? SOURCE_WORDS.local : role.model} — {SOURCE_WORDS[role.source]}
              </span>
            )}
          </li>
        ))}
      </ul>

      {error && <p className="m-0 text-[12.5px] text-danger">{error}</p>}
    </section>
  );
}
