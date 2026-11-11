"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import type { MeetingListDTO } from "@/lib/dto";
import type { MeetingDecision } from "@/db/enums";
import { formatDayHeading, todayLocal } from "../activity/format";
import { Button, Chip, Input, List } from "../ui";
import { MeetingRow } from "./meeting-row";
import { openMeeting } from "./open-meeting";
import { useRecorder } from "./use-recorder";

const JSON_HEADERS = { "content-type": "application/json" };

interface Props {
  today: string;
  meetings: MeetingListDTO[];
  /** `?container=<id>` on this same `/planner/meetings` route, not a dedicated
   * `/planner/meetings/c/[id]` one — the Planner is already a route per *view* (`/planner`,
   * `/planner/week`, `/planner/meetings`), with a query param for scope *within* a view
   * (`?date=` on the day route, `?start=` on the week route); a project scope is that same kind
   * of sub-state on the meetings route, not a fourth view. Parsed and validated once by the page
   * (`app/planner/meetings/page.tsx`) rather than re-parsed here from the raw query string,
   * so the two can never disagree on what counts as a valid id (review N1). */
  containerId?: number | null;
  onRefresh?: () => void;
}

/** The local calendar day a meeting starts on. The domain has the same function, but it
 * lives beside the database and would drag drizzle into the client bundle. */
export const dayOf = (iso: string) => todayLocal(new Date(iso));

interface Group {
  key: string;
  label: string;
  meetings: MeetingListDTO[];
}

/** "default" hides not-going (Step 7's own ask); the other two are the pair design §5 names:
 * "everything" and "only the ones you are not going to". */
type MeetingFilter = "default" | "everything" | "not-going";

const FILTERS: { key: MeetingFilter; label: string }[] = [
  { key: "default", label: "Hide declined" },
  { key: "everything", label: "Everything" },
  { key: "not-going", label: "Only not going" },
];

/** Which meetings a filter setting keeps. */
function applyFilter(list: MeetingListDTO[], filter: MeetingFilter): MeetingListDTO[] {
  if (filter === "everything") return list;
  if (filter === "not-going") return list.filter((m) => m.decision === "not-going");
  return list.filter((m) => m.decision !== "not-going");
}

/** Title, organizer, and attendee names, the three things the spec says the box searches. */
function matches(m: MeetingListDTO, q: string): boolean {
  return [m.title, m.organizer, ...m.attendeeNames].join(" ").toLowerCase().includes(q);
}

/** "15 Nov": enough to place a holiday in the month without a heading of its own. */
function shortDay(startsAt: string): string {
  const d = new Date(startsAt);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function groupByDay(meetings: MeetingListDTO[]): Group[] {
  const groups = new Map<string, MeetingListDTO[]>();
  for (const m of meetings) {
    const day = dayOf(m.startsAt);
    const list = groups.get(day);
    if (list) list.push(m);
    else groups.set(day, [m]);
  }
  return [...groups].map(([key, list]) => ({ key, label: formatDayHeading(key), meetings: list }));
}

export function MeetingsView({ today, meetings, containerId: containerFilter = null, onRefresh }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A dismissed suggestion is a "not now", not a "never" -- nothing here is written for it, so
  // it is only ever known for this render of the page (brief's own words: a dismissal table is
  // more machinery than the feature needs). It may reappear on reload; that is the deliberate
  // trade, not a bug.
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<number>>(new Set());
  // Null until the server has answered: a switch that renders before then would render a guess.
  // Just the names, for the attribution chip's label. The meeting payload carries `containerId`
  // but not what it is called, and widening it would mean a new field on every meeting fixture in
  // the suite for a string this one control uses. Same list the picker itself reads.
  const [containerNames, setContainerNames] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/containers?status=active", { cache: "no-store" }).catch(() => null);
      if (!res?.ok || cancelled) return;
      const list = (await res.json()) as { id: number; name: string }[];
      if (!cancelled) setContainerNames(new Map(list.map((c) => [c.id, c.name])));
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // The switches and the feed link live behind one control; with no meetings at all the panel
  // opens on its own, since connecting a calendar is then the only thing to do here.
  // Design §5 names two states -- "everything" and "only the ones you are not going to" -- and
  // Step 7 separately wants declined meetings out of the way by default; a meeting decided
  // not-going stays in the record forever (nothing here ever deletes or archives it), so a third,
  // default state that simply hides it costs nothing. "default" here means neither of the two
  // named states: not-going hidden, without narrowing down to only not-going either.
  const [filter, setFilter] = useState<MeetingFilter>("default");
  const recorder = useRecorder();

  // A project scope, when one is given, narrows the whole window down before search or the
  // decision filter ever see it -- the same list every other control here already works from,
  // rather than a second, parallel path. `meetings` itself is already effectively unbounded in
  // this case (the page widens `from`/`to` to all time whenever `?container=` is present, review
  // F2), so an empty result here can only mean no *calendar* meetings were ever filed to this
  // container -- a container whose only filed meetings are ad-hoc (no calendar event behind
  // them) still lands here empty, which is why the empty-state copy says "calendar meetings"
  // rather than a bare "meetings".
  const scoped = containerFilter === null ? meetings : meetings.filter((m) => m.item?.containerId === containerFilter);
  const q = query.trim().toLowerCase();
  const searched = q ? scoped.filter((m) => matches(m, q)) : scoped;
  const shown = applyFilter(searched, filter);
  const todays = shown.filter((m) => dayOf(m.startsAt) === today);
  const upcoming = groupByDay(shown.filter((m) => dayOf(m.startsAt) > today));
  // A day that holds a meeting keeps its own card, all-day entries and all. A day that holds
  // nothing but all-day entries has nothing to show a card for.
  const upcomingDays = upcoming.filter((g) => g.meetings.some((m) => !m.allDay));
  const allDayOnly = upcoming.filter((g) => g.meetings.every((m) => m.allDay));
  const past = groupByDay(shown.filter((m) => dayOf(m.startsAt) < today)).reverse();

  function open(id: number) {
    void (async () => {
      const itemId = await openMeeting(id);
      if (itemId === null) {
        setError("Could not open that meeting");
        return;
      }
      setError(null);
      router.push(`/items/${itemId}`);
    })();
  }

  function setNoRecord(id: number, noRecord: boolean) {
    void (async () => {
      const res = await fetch(`/api/meetings/${id}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ noRecord }) });
      if (!res.ok) {
        setError("Could not save that change");
        return;
      }
      setError(null);
      onRefresh?.();
    })();
  }

  /** Writes a decision -- a local fact this app keeps for itself, never a message to the
   * calendar server (design §1.1). */
  /**
   * Attributing a meeting to the project or area it counts against. Same shape as `setDecision`
   * below it, and the same single write -- the route decides what a series assignment means.
   */
  function setContainer(id: number, containerId: number | null, scope: "occurrence" | "series") {
    void (async () => {
      const res = await fetch(`/api/meetings/${id}/container`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ containerId, scope }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "Could not save that change");
        return;
      }
      setError(null);
      onRefresh?.();
    })();
  }

  function setDecision(id: number, decision: MeetingDecision, scope: "occurrence" | "series") {
    void (async () => {
      const res = await fetch(`/api/meetings/${id}/decision`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ decision, scope }) });
      if (!res.ok) {
        setError("Could not save that change");
        return;
      }
      setError(null);
      onRefresh?.();
    })();
  }

  /** The offer's accept: the same `PATCH /api/items/[id]` a person filing the item by hand would
   * hit, never a path of its own -- this is the only write the suggestion chip ever makes, and
   * only once someone has said yes to it (design "no button implies an action it didn't take"). */
  function acceptSuggestion(m: MeetingListDTO) {
    if (m.itemId === null || !m.suggestedContainer) return;
    const containerId = m.suggestedContainer.id;
    void (async () => {
      const res = await fetch(`/api/items/${m.itemId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ containerId }) });
      if (!res.ok) {
        setError("Could not file that meeting");
        return;
      }
      setError(null);
      onRefresh?.();
    })();
  }

  /** The offer's dismiss: session-local only, so it never needs a table to remember it. */
  function dismissSuggestion(id: number) {
    setDismissedSuggestions((prev) => new Set(prev).add(id));
  }

  /** The only outward action a decision ever takes: opening Calendar so the person can tell the
   * organiser themselves, by hand. Nothing here sends anything on their behalf. */
  function openCalendar() {
    void fetch("/api/meetings/open-calendar", { method: "POST" }).catch(() => {
      /* the app itself is still there to open by hand if the shell call fails */
    });
  }


  /** The offer band under an uncontained meeting's row: "Looks like <container>?" with an
   * accept and a dismiss, and nothing else -- an offer, never an assignment. Nothing renders
   * once a meeting is filed (its `suggestedContainer` goes away server-side the moment
   * `item.containerId` is no longer null) or once this session has dismissed it. */
  function suggestionBand(m: MeetingListDTO) {
    if (!m.suggestedContainer || dismissedSuggestions.has(m.id)) return null;
    const suggestion = m.suggestedContainer;
    return (
      <li
        key={`${m.id}-suggestion`}
        aria-label={`Suggested project or area for ${m.title}`}
        className="hairline-row flex items-center gap-2 flex-wrap px-3 py-1.5 pl-[calc(6rem+0.75rem)] text-[12px] text-fg-muted"
      >
        <span>
          Looks like <span className="text-fg">{suggestion.name}</span>?
        </span>
        <Button size="sm" variant="ghost" onClick={() => acceptSuggestion(m)} aria-label={`File ${m.title} there`} className="shrink-0">
          File it there
        </Button>
        <Button size="sm" variant="ghost" onClick={() => dismissSuggestion(m.id)} aria-label={`Not this one for ${m.title}`} className="shrink-0">
          Not this one
        </Button>
      </li>
    );
  }

  function rows(list: MeetingListDTO[]) {
    return (
      <List>
        {list.map((m) => (
          <Fragment key={m.id}>
            <MeetingRow
              meeting={m}
              onOpen={() => open(m.id)}
              onNoRecord={(noRecord) => setNoRecord(m.id, noRecord)}
              onRecord={() => recorder.record({ calendarEventId: m.id })}
              onDecision={(decision, scope) => setDecision(m.id, decision, scope)}
              onContainer={(containerId, scope) => setContainer(m.id, containerId, scope)}
              containerName={containerNames.get(m.containerId ?? -1) ?? null}
              onOpenCalendar={openCalendar}
              blocked={recorder.blocked}
              recordTitle={recorder.title}
            />
            {suggestionBand(m)}
          </Fragment>
        ))}
      </List>
    );
  }

  /** All-day events are a line of names, not rows: nothing on them can be recorded or joined. */
  function allDayLine(list: MeetingListDTO[]) {
    if (list.length === 0) return null;
    return (
      <div className="flex items-center gap-1.5 flex-wrap px-1" aria-label="All day">
        <span className="font-mono text-[11px] text-fg-faint shrink-0">All day</span>
        {list.map((m) => (
          <Chip key={m.id} onClick={() => open(m.id)} title={m.calendarTitle || undefined}>
            {m.title}
          </Chip>
        ))}
      </div>
    );
  }

  function group(label: string, list: MeetingListDTO[], empty?: string) {
    const timed = list.filter((m) => !m.allDay);
    const allDay = list.filter((m) => m.allDay);
    return (
      <section key={label} className="pane p-2 flex flex-col gap-2">
        <span className="micro px-1">{label}</span>
        {allDayLine(allDay)}
        {list.length === 0 ? <p className="text-[13px] text-fg-faint m-0 px-1 pb-1">{empty}</p> : timed.length > 0 && rows(timed)}
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {containerFilter !== null && (
        <div className="flex items-center gap-2 text-[12.5px] text-fg-muted">
          {/* "This project" would lie for an area's meetings -- `MeetingsSection` renders for
            * both kinds (review F1), and this view has no way to know which one it is. */}
          <span>Showing only meetings filed here.</span>
          <Link href="/planner/meetings" className="focus-ring text-violet-bright hover:underline rounded-sm">
            Show all meetings
          </Link>
        </div>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <Input
          type="search"
          aria-label="Search meetings"
          placeholder="Search meetings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-[320px]"
        />
        {/* The calendar link, the auto-record switches and audio retention all live on
            `/settings` now: they are standing policy rather than something to change while
            reading today's meetings, and they used to be findable only behind this gear. */}
        <Link href="/settings" aria-label="Calendar settings" title="Calendar settings" className="focus-ring rounded-sm text-fg-faint hover:text-fg p-1">
          <Settings2 className="w-4 h-4" aria-hidden />
        </Link>
        <div role="group" aria-label="Filter meetings" className="flex items-center gap-1">
          {FILTERS.map((f) => (
            <Chip key={f.key} active={filter === f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className="h-6 px-2 text-[11.5px]">
              {f.label}
            </Chip>
          ))}
        </div>
        {/* The audit's only entry point in the app -- otherwise this whole feature is reachable
          * only by typing the URL by hand (F4). Placed here, not in the dock: it is a view of
          * this same meetings data, not a new top-level section of the app. */}
        <Button href="/meetings/audit" size="sm" variant="ghost" className="ml-auto">
          The audit
        </Button>
        {/* A disabled button takes no pointer events, so the reason hangs on a wrapper. */}
        <span title={recorder.title ?? undefined}>
          <Button size="sm" onClick={() => recorder.record({ adhoc: true })} disabled={!!recorder.blocked} title={recorder.title ?? undefined}>
            Record now
          </Button>
        </span>
      </div>

      {/* With no calendar connected there is nothing to list and nothing here explains that,
          so the one line that does points at the place that can fix it. Every surface that
          reports a missing dependency has to offer the way to supply it. */}
      {meetings.length === 0 && (
        <p className="m-0 text-[12.5px] text-fg-muted">
          No meetings in this window.{" "}
          <a href="/settings" className="focus-ring rounded-sm underline hover:text-fg">
            Connect a calendar in Settings
          </a>
          .
        </p>
      )}

      {/* With nothing to group, the groups are all empty lines saying the same thing: one line
        * says it once. The setup card above the tabs carries the fix when there is one. An empty
        * `shown` can mean the window truly holds nothing, a search matched nothing, or -- once a
        * filter can hide things -- that everything in the window was filtered out; each says the
        * true reason rather than always claiming the window itself is empty. */}
      {shown.length === 0 ? (
        <p className="text-[13px] text-fg-faint m-0">
          {q
            ? "No meetings match that search"
            : scoped.length === 0
              ? containerFilter !== null
                // Never a bare "no meetings": this view only ever holds meetings with a calendar
                // event behind them, so a container whose only filed meetings are ad hoc
                // recordings or dropped-in audio (no calendar event at all) would otherwise read
                // as having nothing filed, when the project page's own Meetings section may show
                // several (review F2 residual).
                ? "No calendar meetings are filed here"
                : "No meetings in the next 60 days"
              : filter === "not-going"
                ? "Nothing here is marked not going"
                : 'Everything in this window is marked not going. Switch to "Everything" to see it.'}
        </p>
      ) : (
        <>
          {group("Today", todays, "No meetings today")}
          {upcomingDays.map((g) => group(g.label, g.meetings))}
          {/* A subscribed holiday calendar fills the next two months with days whose only entry
            * is a holiday. Each one used to take a card of its own -- a heading, a chip, and the
            * height of a meeting -- so six holidays pushed every real meeting below the fold.
            * They are worth seeing and not worth a card each, so they share one. */}
          {allDayOnly.length > 0 && (
            <section className="pane p-2 flex flex-col gap-2">
              <span className="micro px-1">All day</span>
              <div className="flex items-center gap-1.5 flex-wrap px-1 pb-1">
                {allDayOnly.flatMap((g) => g.meetings).map((m) => (
                  <Chip key={m.id} onClick={() => open(m.id)} title={m.calendarTitle || undefined}>
                    {m.title}
                    <span className="text-fg-faint ml-1.5">{shortDay(m.startsAt)}</span>
                  </Chip>
                ))}
              </div>
            </section>
          )}

          <details className="pane p-2">
            {/* "Past 30 days" is only true of the normal window; a `?container=` filter widens
              * the underlying fetch to all time (review F2), so this group can hold meetings well
              * older than that here, and the heading says so rather than naming a window that no
              * longer applies. */}
            <summary className="micro px-1 cursor-pointer focus-ring rounded-sm">{containerFilter !== null ? "Earlier" : "Past 30 days"}</summary>
            <div className="flex flex-col gap-2 pt-2">
              {past.length === 0 ? (
                <p className="text-[13px] text-fg-faint m-0 px-1">{containerFilter !== null ? "Nothing earlier" : "Nothing in the past 30 days"}</p>
              ) : (
                past.map((g) => (
                  <div key={g.key} className="flex flex-col gap-1">
                    <span className="micro px-1">{g.label}</span>
                    {allDayLine(g.meetings.filter((m) => m.allDay))}
                    {g.meetings.some((m) => !m.allDay) && rows(g.meetings.filter((m) => !m.allDay))}
                  </div>
                ))
              )}
            </div>
          </details>
        </>
      )}
      {(error ?? recorder.error) && <p className="text-danger text-[12.5px] m-0">{error ?? recorder.error}</p>}
    </div>
  );
}
