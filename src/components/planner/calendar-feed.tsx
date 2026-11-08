"use client";

import { useEffect, useState } from "react";
import { CalendarSync, RefreshCw } from "lucide-react";
import type { CalendarFeedDTO } from "@/lib/dto";
import { sinceLabel } from "../activity/format";
import { Button, Input } from "../ui";

const FEED_URL = "/api/settings/calendar";
const JSON_HEADERS = { "content-type": "application/json" };

/**
 * A published calendar link (Outlook on the web › Settings › Calendar › Shared calendars ›
 * Publish) that the server polls every five minutes. Saving syncs at once, so the row can say
 * straight away whether the link works.
 */
export function CalendarFeed({ onSynced }: { onSynced?: () => void }) {
  const [state, setState] = useState<CalendarFeedDTO | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(FEED_URL, { cache: "no-store" });
        if (res.ok && !cancelled) setState((await res.json()) as CalendarFeedDTO);
      } catch {
        /* the row simply stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function send(init: RequestInit, url = FEED_URL) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(url, init);
      const body = (await res.json().catch(() => null)) as (CalendarFeedDTO & { error?: string }) | null;
      if (!res.ok || !body) {
        setProblem(body?.error ?? "Could not save the link");
        return;
      }
      setState(body);
      setDraft(null);
      if (body.sync?.state === "ok") onSynced?.();
    } catch {
      setProblem("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  const value = draft ?? state.feedUrl;
  const dirty = draft !== null && draft.trim() !== state.feedUrl;
  const linked = state.feedUrl !== "";

  return (
    <section className="pane p-3 flex flex-col gap-2" aria-label="Calendar feed">
      <div className="flex items-center gap-2 flex-wrap">
        <CalendarSync className="w-4 h-4 text-fg-muted shrink-0" aria-hidden />
        <Input
          size="sm"
          type="url"
          aria-label="Published calendar link"
          placeholder="Paste a published Outlook calendar link"
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) void send({ method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ feedUrl: value }) });
          }}
          className="flex-1 min-w-[240px] max-w-[560px] font-mono text-[12px]"
        />
        <Button size="sm" variant="primary" disabled={!dirty || busy} onClick={() => void send({ method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ feedUrl: value }) })}>
          {linked && value.trim() === "" ? "Remove link" : "Save link"}
        </Button>
        {linked && (
          <Button size="sm" icon={RefreshCw} disabled={busy} onClick={() => void send({ method: "POST" }, `${FEED_URL}/sync`)}>
            Sync now
          </Button>
        )}
      </div>
      <p className="text-[12.5px] m-0" role="status">
        {problem ? (
          <span className="text-danger">{problem}</span>
        ) : !linked ? (
          <span className="text-fg-faint">In Outlook on the web: Settings › Calendar › Shared calendars › Publish a calendar, then paste the ICS link here.</span>
        ) : state.error ? (
          <span className="text-danger">{state.error}</span>
        ) : state.syncedAt ? (
          <span className="text-fg-muted">
            Synced {state.count} {state.count === 1 ? "event" : "events"} {sinceLabel(state.syncedAt)}. Checked every five minutes.
          </span>
        ) : (
          <span className="text-fg-faint">Waiting for the first sync</span>
        )}
      </p>
    </section>
  );
}
