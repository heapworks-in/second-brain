"use client";

import type { FocusBreakDTO, FocusRunDTO, FocusSettingsDTO } from "@/lib/dto";
import type { FocusMode, FocusOutcome } from "@/db/enums";

/** Slow enough to cost nothing: nothing but this browser starts a run, so the poll exists only
 * to notice one started in another tab — the same shape as `useRecorder`'s own poll. */
const POLL_MS = 60_000;
const TICK_MS = 1000;

const DEFAULT_SETTINGS: FocusSettingsDTO = { defaultMinutes: 25, shortBreak: 5, longBreak: 15, longBreakEvery: 4, mode: "pomodoro" };

export interface StartFocusInput {
  /** Left out for a pomodoro on nothing in particular. */
  taskId?: number | null;
  /** The session this run belongs to. Its own length is used unless `minutes` overrides it —
   * never recomputed here from the block's own minutes, which the server already knows. */
  blockId?: number | null;
  minutes?: number;
}

/** What `sb:focus-completed` carries: a natural completion (never a stop or an abandon), the
 * count of the day's completions including this one, and the settings that say how long a
 * break is. Dispatched app-wide rather than kept as store state, because the surface that
 * finishes a run and the break offer that reads it are two different mounted components. */
export interface FocusCompletedDetail {
  run: FocusRunDTO;
  completedToday: number;
  settings: FocusSettingsDTO;
  /** Design §4.5: where the machine actually was during the run, from `PATCH /api/focus/[id]`'s
   * own `where`, carried through rather than discarded — `[]` when the activity helper has never
   * reported, or reported nothing that overlaps this run. */
  where: { label: string; ms: number }[];
}

export interface FocusStoreState {
  run: FocusRunDTO | null;
  settings: FocusSettingsDTO;
  completedToday: number;
  /** Milliseconds left in the live run, zero while idle. Recomputed against the wall clock
   * every time it can change — on load, on start, and once a second while live — never carried
   * forward from a stale "now" seeded once at mount. */
  remainingMs: number;
  busy: boolean;
  error: string | null;
  /** Whether the store's own `GET /api/focus` has landed at least once. `false` cannot be told
   * apart from "loaded and there is no run" by `run` alone — a caller with a server-rendered
   * payload of its own (Home's first paint) must read `loaded` to know whether `run` is this
   * store's real answer yet, rather than falling back to a run that may already be over. */
  loaded: boolean;
  /** The running break, from the server rather than this component tree: a break used to be a
   * `useState` countdown inside the break offer, so opening another page cancelled it silently. */
  breakState: FocusBreakDTO;
}

const NO_BREAK: FocusBreakDTO = { endsAt: null, remainingMs: 0, minutes: 0 };

const INITIAL_STATE: FocusStoreState = {
  run: null,
  settings: DEFAULT_SETTINGS,
  completedToday: 0,
  remainingMs: 0,
  busy: false,
  error: null,
  loaded: false,
  breakState: NO_BREAK,
};

/** A break's time left, against the wall clock -- the same discipline `remainingFor` applies to a
 *  run, so a tab asleep through the whole break wakes up showing it over, not frozen mid-count. */
export function remainingBreak(breakState: FocusBreakDTO, now: number = Date.now()): number {
  return breakState.endsAt ? Math.max(0, Date.parse(breakState.endsAt) - now) : 0;
}

/** The run's planned end, in epoch ms — the one place it is computed, so the countdown and the
 * auto-finish check can never disagree about when zero is reached. */
function plannedEnd(run: FocusRunDTO): number {
  return Date.parse(run.startedAt) + run.plannedMinutes * 60_000;
}

/** Exported so a component with a run of its own from elsewhere — Home's server-rendered
 * `focus.running`, before this store has loaded — can compute its remaining time with the same
 * arithmetic the store ticks with, rather than a second copy of it (F8). */
export function remainingFor(run: FocusRunDTO | null): number {
  return run ? Math.max(0, plannedEnd(run) - Date.now()) : 0;
}

/**
 * The one live copy of the focus run, module-level rather than per-component: every
 * `useFocus()` call subscribes to the same object instead of fetching, polling and ticking on
 * its own. However many `FocusButton`s, `FocusChip`s and the rest are mounted, this store makes
 * exactly one fetch on the first of them, keeps exactly one poll and one one-second tick running
 * while any of them are mounted, and finishes a completed run exactly once — the guard below is
 * one variable, not one per component, so there is nothing left to race.
 *
 * A plain module rather than a React context: nothing to provide, and a test reaches it (and
 * resets it) without wrapping anything.
 */
let state: FocusStoreState = INITIAL_STATE;
const listeners = new Set<() => void>();
let subscriberCount = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let onFocusChanged: (() => void) | null = null;
/** The id of the run an auto-finish PATCH is already in flight for — set synchronously, in the
 * same call that reads it, whether that call is the tick noticing zero or a manual Stop, so
 * whichever loses the race sees the guard already up and never sends a second PATCH. */
let finishingId: number | null = null;
/** The id of a run whose automatic (tick-triggered) finish PATCH has already failed once.
 * Sticky until a `load()` that happens on its own account — the poll, another tab's own
 * `sb:focus-changed`, or a remount — next replaces `state.run`; the tick checks it so a failed
 * attempt is not refired every second, but a manual Stop (`finish`) is never gated by it. */
let autoFinishFailedId: number | null = null;
/** True whenever there is no subscriber to serve. Checked by `load()` after every `await`, so a
 * request already in flight when the last subscriber unmounts cannot write to `state` (and, by
 * calling `setState`, arm a tick interval) after the engine believes it has stopped. */
let engineStopped = true;

function setState(patch: Partial<FocusStoreState>): void {
  state = { ...state, ...patch };
  syncTick();
  for (const listener of listeners) listener();
}

/** Starts the one-second tick while a run is live, stops it the instant one is not — checked
 * after every state change rather than owned by a React effect, so it needs no component to
 * exist at all. With no subscriber left this always stops it: a state change from a request that
 * outlived its engine must never arm a timer nothing is around to clear. */
function syncTick(): void {
  const live = subscriberCount > 0 && (state.run !== null || state.breakState.endsAt !== null);
  if (live && !tickTimer) {
    tickTimer = setInterval(tick, TICK_MS);
  } else if (!live && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function tick(): void {
  // A break counts down here rather than in the component that shows it, so every surface reads
  // one clock. Reaching zero clears it locally; the server already reports an elapsed break as
  // none, so there is nothing to tell it.
  let next = state;
  if (next.breakState.endsAt) {
    const remaining = remainingBreak(next.breakState);
    next = { ...next, breakState: remaining <= 0 ? NO_BREAK : { ...next.breakState, remainingMs: remaining } };
  }
  const run = next.run;
  if (!run) {
    if (next !== state) {
      state = next;
      syncTick();
      for (const listener of listeners) listener();
    }
    return;
  }
  const remainingMs = remainingFor(run);
  state = { ...next, remainingMs };
  for (const listener of listeners) listener();
  if (remainingMs <= 0 && finishingId !== run.id && autoFinishFailedId !== run.id) {
    finishingId = run.id;
    void finishRun(run.id, "completed", { auto: true });
  }
}

async function load(): Promise<void> {
  try {
    const res = await fetch("/api/focus", { cache: "no-store" });
    if (!res.ok || engineStopped) return;
    const data = (await res.json()) as {
      run: FocusRunDTO | null;
      settings: FocusSettingsDTO;
      completedToday: number;
      // Absent from a server that predates the break living server-side; read as no break rather
      // than undefined, which would take down every surface that renders it.
      break?: FocusBreakDTO;
    };
    if (engineStopped) return;
    // A load reflects the server's own truth, so it is the one thing allowed to give the tick
    // another chance at a run whose auto-finish previously failed (F9).
    autoFinishFailedId = null;
    const serverBreak = data.break ?? NO_BREAK;
    // Each field falls back rather than being trusted to be present. A payload missing `settings`
    // used to blank them for every focus surface at once, and `settings.longBreakEvery` is read
    // while rendering -- so a partial answer, from a server mid-deploy or any other cause, took
    // the pane down rather than degrading.
    setState({
      run: data.run ?? null,
      settings: data.settings ?? state.settings,
      completedToday: data.completedToday ?? 0,
      remainingMs: remainingFor(data.run ?? null),
      loaded: true,
      breakState: serverBreak.endsAt ? { ...serverBreak, remainingMs: remainingBreak(serverBreak) } : NO_BREAK,
    });
  } catch {
    /* offline: the next poll or event retries */
  }
}

async function finishRun(id: number, outcome: FocusOutcome, opts: { auto?: boolean } = {}): Promise<void> {
  setState({ busy: true });
  let failed = false;
  try {
    const res = await fetch(`/api/focus/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      failed = true;
      setState({ error: (body as { error?: string } | null)?.error ?? "Could not finish the run" });
      return;
    }
    // `where` is absent whenever the activity helper has never reported, and the break offer
    // reads it the moment this event lands: a missing key here would throw inside a component
    // mounted on every page.
    const { run: finished, where } = body as { run: FocusRunDTO; where?: { label: string; ms: number }[] };
    // Read straight from the store's own state, not from inside a `setState` updater: there is
    // no queued function to run later, only a plain variable, so "including this one" below is
    // exact rather than a guess at whatever the next poll happens to see.
    const completedToday = state.completedToday + 1;
    const settings = state.settings;
    setState({ run: null, remainingMs: 0, error: null });
    if (finished.outcome === "completed") {
      window.dispatchEvent(
        new CustomEvent<FocusCompletedDetail>("sb:focus-completed", { detail: { run: finished, completedToday, settings, where: where ?? [] } }),
      );
    }
  } catch {
    failed = true;
    setState({ error: "Could not finish the run" });
  } finally {
    setState({ busy: false });
    finishingId = null;
    // A failed automatic attempt marks itself instead of dispatching: dispatching here would
    // have the store's own `sb:focus-changed` listener call `load()` right back, clear the guard
    // a moment later, and let the very next tick retry — exactly the 1 Hz loop being fixed (F9).
    if (opts.auto && failed) {
      autoFinishFailedId = id;
    } else {
      window.dispatchEvent(new Event("sb:focus-changed"));
    }
  }
}

function startEngine(): void {
  engineStopped = false;
  void load();
  onFocusChanged = () => void load();
  window.addEventListener("sb:focus-changed", onFocusChanged);
  pollTimer = setInterval(() => void load(), POLL_MS);
  syncTick();
}

function stopEngine(): void {
  engineStopped = true;
  if (onFocusChanged) {
    window.removeEventListener("sb:focus-changed", onFocusChanged);
    onFocusChanged = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** For `useSyncExternalStore`. The engine starts on the first subscriber and stops when the
 * last one leaves — a page with nothing focus-aware mounted costs nothing at all. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  subscriberCount += 1;
  if (subscriberCount === 1) startEngine();
  return () => {
    listeners.delete(listener);
    subscriberCount -= 1;
    if (subscriberCount === 0) stopEngine();
  };
}

export function getSnapshot(): FocusStoreState {
  return state;
}

export function getServerSnapshot(): FocusStoreState {
  return INITIAL_STATE;
}

/** Returns once the write settles, so a caller that starts a second run right after stopping
 * the first — `⌘⇧F` switching tasks — can sequence the two instead of firing them together and
 * letting whichever response lands last win. Callers that only fire-and-forget (a click handler)
 * are free to ignore the promise; it never rejects, every failure path resolves through `error`. */
export async function start(input: StartFocusInput): Promise<void> {
  setState({ busy: true });
  try {
    const res = await fetch("/api/focus", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setState({ error: (body as { error?: string } | null)?.error ?? "Could not start a run" });
      return;
    }
    const run = body as FocusRunDTO;
    setState({ run, remainingMs: remainingFor(run), error: null });
  } catch {
    setState({ error: "Could not start a run" });
  } finally {
    setState({ busy: false });
    window.dispatchEvent(new Event("sb:focus-changed"));
  }
}

export async function finish(outcome: FocusOutcome): Promise<void> {
  const run = state.run;
  if (!run) return;
  // The auto-finish tick, or another call to `finish`, may already be closing this same run —
  // `⌘⇧F` reaches this directly and carries no `disabled={busy}` of its own to shield it the way
  // the Stop buttons do.
  if (finishingId === run.id) return;
  finishingId = run.id;
  await finishRun(run.id, outcome);
}

/**
 * Take the break the cycle calls for, or one of a given length. The server decides the default so
 * the pane and the break offer cannot disagree about whether this one is the long one.
 */
export async function takeBreak(minutes?: number): Promise<void> {
  setState({ busy: true });
  try {
    const res = await fetch("/api/focus/break", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minutes === undefined ? {} : { minutes }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setState({ error: (body as { error?: string } | null)?.error ?? "Could not start a break" });
      return;
    }
    const started = body as FocusBreakDTO;
    setState({ breakState: { ...started, remainingMs: remainingBreak(started) }, error: null });
  } catch {
    setState({ error: "Could not start a break" });
  } finally {
    setState({ busy: false });
  }
}

/** Back to work early. Clears locally first: the button should not look stuck on a slow request. */
export async function endBreak(): Promise<void> {
  setState({ breakState: NO_BREAK, busy: true });
  try {
    await fetch("/api/focus/break", { method: "DELETE" });
  } catch {
    /* the next poll reconciles */
  } finally {
    setState({ busy: false });
  }
}

/**
 * Switches the rhythm the pane offers, and so what the end of a run asks for. Written through
 * `PATCH /api/settings/focus` like any other saved default, but shown immediately and rolled back
 * if the write fails: a tab that waits on a round trip reads as broken, and a tab that lies about
 * what it saved is worse.
 */
export async function setMode(mode: FocusMode): Promise<void> {
  const before = state.settings;
  if (before.mode === mode) return;
  setState({ settings: { ...before, mode }, error: null });
  try {
    const res = await fetch("/api/settings/focus", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) setState({ settings: before, error: "Could not switch the rhythm" });
  } catch {
    setState({ settings: before, error: "Could not switch the rhythm" });
  }
}

/**
 * Whether a finished run was a box rather than a pomodoro — read by both surfaces that answer
 * the end of a run, so the break offer and the box verdict can never both appear, or both stay
 * away. The rhythm in force when the run finished decides it, not whether the run happened to
 * hang off a session on the timeline: pressing focus on a block while keeping the pomodoro
 * rhythm is still a pomodoro, and it still earns its break.
 */
export function wasBox(detail: FocusCompletedDetail): boolean {
  return detail.settings.mode === "timebox";
}

/** Test-only: drops every timer and listener and puts the store back to its initial state, so
 * one test file's runs cannot leak into the next. */
export function resetFocusStore(): void {
  stopEngine();
  listeners.clear();
  subscriberCount = 0;
  finishingId = null;
  autoFinishFailedId = null;
  state = INITIAL_STATE;
}
