"use client";

import { useSyncExternalStore } from "react";
import type { FocusBreakDTO, FocusRunDTO, FocusSettingsDTO } from "@/lib/dto";
import type { FocusMode, FocusOutcome } from "@/db/enums";
import * as store from "./focus-store";

export type { StartFocusInput, FocusCompletedDetail } from "./focus-store";

export interface UseFocusResult {
  run: FocusRunDTO | null;
  /** Whether the store's own `GET /api/focus` has landed yet. A caller holding a run of its own
   * from elsewhere — a server-rendered payload — must read this before falling back to it:
   * `false` and "loaded, and there is no run" both leave `run` null, and only `loaded` tells
   * them apart. */
  loaded: boolean;
  settings: FocusSettingsDTO;
  completedToday: number;
  /** Milliseconds left in the live run, zero while idle. Ticks once a second; never asks the
   * server to recompute it. */
  remainingMs: number;
  /** Resolves once the write settles — never rejects — so a caller that needs to sequence a
   * stop and a start (`⌘⇧F` switching tasks) can await it; a click handler is free to not. */
  start: (input: store.StartFocusInput) => Promise<void>;
  finish: (outcome: FocusOutcome) => Promise<void>;
  busy: boolean;
  error: string | null;
  /** The running break. Server-held, so it outlives the component that started it. */
  breakState: FocusBreakDTO;
  /** Take the break the cycle calls for, or one of a given length. */
  takeBreak: (minutes?: number) => Promise<void>;
  endBreak: () => Promise<void>;
  /** Switch between the pomodoro cycle and the timebox. Saved, so it holds across pages. */
  setMode: (mode: FocusMode) => Promise<void>;
}

/**
 * The one hook every focus surface reads from — a thin `useSyncExternalStore` subscription onto
 * `focus-store.ts`'s single module-level run. Mounting this a hundred times over still makes
 * one fetch, keeps one poll and one tick running, and finishes a completed run exactly once:
 * the store, not this hook, is what owns any of that.
 */
export function useFocus(): UseFocusResult {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return {
    run: state.run,
    loaded: state.loaded,
    settings: state.settings,
    completedToday: state.completedToday,
    remainingMs: state.remainingMs,
    start: store.start,
    finish: store.finish,
    busy: state.busy,
    error: state.error,
    breakState: state.breakState,
    takeBreak: store.takeBreak,
    endBreak: store.endBreak,
    setMode: store.setMode,
  };
}
