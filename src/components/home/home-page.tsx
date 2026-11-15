"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { HomeDTO } from "@/lib/dto";
import { TopBand } from "./top-band";
import { NowNext } from "./now-next";
import { ProjectCards } from "./project-cards";
import { RecentList } from "./recent-list";
import { ActivityLine } from "./activity-line";

/** Everything that can change what Home says, from anywhere in the app. `sb:focus-changed` is
 * what a run starting or finishing dispatches — the top band's focused minutes are read off
 * this same payload, not off the live store, so a run landing has to ask for a fresh one. */
const CHANGE_EVENTS = ["sb:plan-changed", "sb:tasks-changed", "sb:inbox-changed", "sb:recording-changed", "sb:focus-changed"] as const;

/** One interaction often moves a task and the plan in the same breath, and the payload carries
 * the Planner's whole day; the events are let to settle into one request, as the Planner does. */
const REFRESH_MS = 50;

/**
 * Where the day stands. The payload is built on the server and handed in whole; from then on
 * the page reads it back off `/api/home` whenever anything says the day has moved, with the
 * Planner shell's own trailing debounce and request token so a stale answer never lands.
 */
export function HomePage({ initial }: { initial: HomeDTO }) {
  const [data, setData] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef(0);

  // A refresh still waiting when the page goes belongs to nothing; the token would ignore its
  // answer anyway, but the timer has no reason to outlive the page that set it.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const id = ++request.current;
      void (async () => {
        // A refresh that cannot reach the server leaves the day as it stands; the next event
        // asks again. An unhandled rejection here would take the page down with it.
        const res = await fetch("/api/home").catch(() => null);
        if (!res?.ok) return;
        const body = (await res.json()) as HomeDTO;
        // A slower earlier request answering last would put the day back as it was.
        if (id === request.current) setData(body);
      })();
    }, REFRESH_MS);
  }, []);

  useEffect(() => {
    for (const name of CHANGE_EVENTS) window.addEventListener(name, refresh);
    return () => {
      for (const name of CHANGE_EVENTS) window.removeEventListener(name, refresh);
    };
  }, [refresh]);

  /** The capacity is reckoned server-side, so new hours are saved and then read back whole. */
  const saveHours = useCallback(
    (workHours: string) => {
      void (async () => {
        const res = await fetch("/api/settings/planner", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workHours }) });
        if (res.ok) refresh();
        else window.dispatchEvent(new CustomEvent("sb:toast", { detail: { text: "Could not save the hours" } }));
      })();
    },
    [refresh],
  );

  /** Same round trip as `saveHours`, for the days the hours apply to. */
  const saveWorkingDays = useCallback(
    (workingDays: number[]) => {
      void (async () => {
        const res = await fetch("/api/settings/planner", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workingDays }) });
        if (res.ok) refresh();
        else window.dispatchEvent(new CustomEvent("sb:toast", { detail: { text: "Could not save the working days" } }));
      })();
    },
    [refresh],
  );

  return (
    <div className="w-full px-6 lg:px-8 pt-8 flex flex-col gap-6">
      <TopBand
        day={data.day}
        counts={data.counts}
        blocked={data.blocked}
        focus={data.focus}
        review={data.review}
        meetingShare={data.meetingShare}
        stalledGoals={data.stalledGoals}
        duePredictions={data.duePredictions}
        onHours={saveHours}
        onWorkingDays={saveWorkingDays}
      />

      <div className="flex flex-col gap-2">
        <NowNext day={data.day} today={data.today} now={data.now} next={data.next} focus={data.focus} />
        <div className="flex justify-end">
          <Link href="/planner" className="focus-ring rounded-sm text-[12px] text-fg-muted hover:text-fg transition-colors duration-150">
            Open the Planner
          </Link>
        </div>
      </div>

      {/* Two columns from 1100 px. Below that they stack in source order, so a phone reads the
        * band, then what is on now, then projects, then what has recently moved. */}
      <div className="grid grid-cols-1 min-[1100px]:grid-cols-[5fr_4fr] gap-6 items-start">
        <div className="min-w-0">
          <ProjectCards projects={data.projects} today={data.today} />
        </div>
        <div className="flex flex-col gap-6 min-w-0">
          <RecentList recent={data.recent} now={Date.parse(data.generatedAt)} />
          <ActivityLine activity={data.activity} />
        </div>
      </div>
    </div>
  );
}
