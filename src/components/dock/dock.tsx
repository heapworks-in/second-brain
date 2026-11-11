"use client";

import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  Archive,
  ArrowsClockwise,
  Ruler,
  BookBookmark,
  CalendarCheck,
  ClipboardText,
  DotsThree,
  Flag,
  House,
  ListBullets,
  MagnifyingGlass,
  Plus,
  Gear,
  Pulse,
  Question,
  Stack,
  Table,
  Target,
  Tray,
  Users,
  type Icon as Glyph,
} from "@phosphor-icons/react";
import { CAPTURE_ITEM, NAV_ITEMS, SEARCH_ITEM, isNavActive, type IconName, type NavItem } from "../nav";
import { PromptBar } from "../shell/prompt-bar";
import { DockItem, type DockItemProps } from "./dock-item";
import { DockSheet } from "./dock-sheet";
import { RecordingChip } from "./recording-chip";
import { FocusChip } from "../focus/focus-chip";
import { useMagnify } from "./use-magnify";
import type { HelperStateDTO, ItemDTO } from "@/lib/dto";

const POLL_MS = 20_000;
const ACTIVITY_POLL_MS = 60_000;
const HELPER_STALE_MS = 120_000;
/** A fetched link stops being pending once its reader run finishes. */
const PENDING_POLL_MS = 2000;
const PENDING_LIMIT_MS = 60_000;
const DIM_THROTTLE_MS = 300;
const NARROW = "(max-width: 719px)";

const ICONS: Record<IconName, Glyph> = {
  home: House,
  desk: ClipboardText,
  settings: Gear,
  planner: CalendarCheck,
  inbox: Tray,
  goal: Target,
  review: ArrowsClockwise,
  log: Ruler,
  project: Flag,
  area: Stack,
  resource: BookBookmark,
  people: Users,
  tracker: Table,
  activity: Pulse,
  library: ListBullets,
  archive: Archive,
  search: MagnifyingGlass,
  capture: Plus,
  help: Question,
};

const BRAIN_ITEMS = NAV_ITEMS.filter((n) => n.section === "brain");
const TOOLS_ITEMS = NAV_ITEMS.filter((n) => n.section === "tools");
/** The two the narrow pill keeps; everything else moves into the sheet. */
const NARROW_ITEMS = NAV_ITEMS.filter((n) => n.href === "/planner" || n.href === "/inbox");
const SHEET_ITEMS = NAV_ITEMS.filter((n) => !NARROW_ITEMS.includes(n));

function subscribeNarrow(listener: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}

function readNarrow(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches;
}

const wideOnServer = () => false;

/** True while the element belongs to whatever the user is writing in, outside the dock. */
function isTypingTarget(el: Element | null, dock: HTMLElement | null): boolean {
  if (!el || dock?.contains(el)) return false;
  if (el.closest(".rich-editor")) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

/**
 * The one object at the bottom of every page: a pill of icons that magnifies under the
 * cursor, and the prompt bar as its expanded state.
 */
export function Dock() {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const [inboxCount, setInboxCount] = useState(0);
  const [helperDown, setHelperDown] = useState(false);
  const [paused, setPaused] = useState(false);
  // The path the bar was opened on rides along with the flag, so leaving the page closes the
  // bar by plain derivation rather than by an effect writing state back.
  const [bar, setBar] = useState({ open: false, path: "" });
  const [draft, setDraft] = useState("");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dimmed, setDimmed] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [deskCount, setDeskCount] = useState(0);
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, wideOnServer);
  // The capture page is the prompt bar writ large, so the bar stays away there and the pill
  // keeps its place rather than leaving the page with nothing at the bottom.
  const open = bar.open && bar.path === pathname && pathname !== "/capture";
  const shellRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLElement>(null);
  const captureRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const magnify = useMagnify({ max: 1.35, radius: 96 });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/inbox?limit=1", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { count: number };
        if (!cancelled) setInboxCount(data.count);
      } catch {
        /* offline */
      }
    }
    void load();
    const id = setInterval(load, POLL_MS);
    window.addEventListener("sb:inbox-changed", load);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("sb:inbox-changed", load);
    };
  }, [pathname]);

  // The desk's own count, on the inbox badge's idiom: polled, and refreshed the moment any
  // surface says the desk changed so the badge never disagrees with the page.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/desk", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { open: number };
        if (!cancelled) setDeskCount(data.open);
      } catch {
        /* offline */
      }
    }
    void load();
    const id = setInterval(load, POLL_MS);
    window.addEventListener("sb:desk-changed", load);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("sb:desk-changed", load);
    };
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/activity/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { helper: HelperStateDTO; paused: boolean };
        if (cancelled) return;
        setPaused(data.paused);
        setHelperDown(!data.paused && (!data.helper.lastSeen || Date.now() - Date.parse(data.helper.lastSeen) > HELPER_STALE_MS));
      } catch {
        /* offline */
      }
    }
    void load();
    const id = setInterval(load, ACTIVITY_POLL_MS);
    window.addEventListener("sb:activity-changed", load);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("sb:activity-changed", load);
    };
  }, [pathname]);

  // `shortcuts.tsx` owns the `c` key; it asks for the bar, which is now the dock's open state.
  useEffect(() => {
    function onRequest() {
      setBar({ open: true, path: pathname });
    }
    window.addEventListener("sb:prompt-focus", onRequest);
    return () => window.removeEventListener("sb:prompt-focus", onRequest);
  }, [pathname]);

  // The caret follows the bar in and back out again: opening is the one intentional autofocus
  // in the app, and closing hands focus to the button that opened it rather than to the body.
  useEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    if (open) shellRef.current?.querySelector<HTMLElement>("input, textarea")?.focus();
    else captureRef.current?.focus();
  }, [open]);

  // The bar hands over the link it just captured; the glow breathes until the reader run for
  // that item finishes, which outlives the bar itself.
  useEffect(() => {
    function onPending(e: Event) {
      setPendingId((e as CustomEvent<{ itemId: number }>).detail?.itemId ?? null);
    }
    window.addEventListener("sb:capture-pending", onPending);
    return () => window.removeEventListener("sb:capture-pending", onPending);
  }, []);

  useEffect(() => {
    if (pendingId === null) return;
    const startedAt = Date.now();
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        if (stopped) return;
        if (Date.now() - startedAt > PENDING_LIMIT_MS) {
          setPendingId(null);
          return;
        }
        try {
          const res = await fetch(`/api/items/${pendingId}`);
          if (!res.ok || stopped) return;
          const item = (await res.json()) as ItemDTO;
          if (!stopped && item.status !== "pending") setPendingId(null);
        } catch {
          /* offline: keep waiting until the limit */
        }
      })();
    }, PENDING_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingId]);

  // Typing anywhere else pushes the dock back; a glance (the pointer) or a focus into it
  // brings it forward again.
  useEffect(() => {
    let lastMove = 0;
    function onFocusIn(e: FocusEvent) {
      setDimmed(isTypingTarget(e.target as Element | null, shellRef.current));
    }
    function onFocusOut() {
      setDimmed(false);
    }
    function onMove() {
      const now = Date.now();
      if (now - lastMove < DIM_THROTTLE_MS) return;
      lastMove = now;
      setDimmed(false);
    }
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointermove", onMove);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointermove", onMove);
    };
  }, []);

  const { reset } = magnify;
  const openBar = useCallback(() => {
    reset();
    setBar({ open: true, path: pathname });
  }, [reset, pathname]);

  const closeBar = useCallback(() => {
    reset();
    setBar({ open: false, path: pathname });
  }, [reset, pathname]);

  const hideSheet = useCallback(() => setSheetOpen(false), []);

  /** Escape or a second press on More: the button that opened the sheet takes focus back. */
  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    moreRef.current?.focus();
  }, []);

  const openPalette = useCallback(() => window.dispatchEvent(new Event("sb:palette")), []);

  const status = paused ? "Paused" : helperDown ? "Not recording" : "Recording";

  function navSlot(item: NavItem): DockItemProps & { key: string } {
    return {
      key: item.href,
      href: item.href,
      label: item.label,
      shortcut: item.shortcut,
      icon: ICONS[item.icon],
      active: isNavActive(pathname, item.href),
      badge: item.badge === "inbox" && inboxCount > 0 ? inboxCount : item.badge === "desk" && deskCount > 0 ? deskCount : undefined,
      dot: item.badge === "activity" && helperDown,
      title: item.badge === "activity" ? status : undefined,
      onClick: sheetOpen ? hideSheet : undefined,
    };
  }

  const captureSlot: DockItemProps & { key: string } = {
    key: "capture",
    label: CAPTURE_ITEM.label,
    shortcut: CAPTURE_ITEM.shortcut,
    icon: ICONS.capture,
    raised: true,
    expanded: open,
    onClick: open ? closeBar : openBar,
    ref: captureRef,
  };
  const searchSlot: DockItemProps & { key: string } = {
    key: "search",
    label: SEARCH_ITEM.label,
    shortcut: SEARCH_ITEM.shortcut,
    icon: ICONS.search,
    onClick: openPalette,
  };

  // The row is built as one ordered list so that its indices, the document order, and the
  // scales the magnify hook reads back out of the DOM all line up.
  const slots: (DockItemProps & { key: string })[] = narrow
    ? [
        ...NARROW_ITEMS.map(navSlot),
        searchSlot,
        captureSlot,
        { key: "more", label: "More", icon: DotsThree, expanded: sheetOpen, onClick: sheetOpen ? closeSheet : () => setSheetOpen(true), ref: moreRef },
      ]
    : [...BRAIN_ITEMS.map(navSlot), ...TOOLS_ITEMS.map(navSlot), searchSlot, captureSlot];
  // Hairlines after the brain group and after the tools group; the narrow pill has neither.
  const dividers = narrow ? [] : [BRAIN_ITEMS.length - 1, BRAIN_ITEMS.length + TOOLS_ITEMS.length - 1];
  // The pill and the bar are one shared element, so opening morphs one into the other. The
  // morph is a layout animation rather than a CSS transition, so reduced motion has to drop
  // the shared id by hand: without it the two just swap.
  const morph = reduce ? {} : { layout: true, layoutId: "dock-shell" };

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40">
      <div
        ref={shellRef}
        data-dock-shell
        className={`relative flex flex-col items-center transition-opacity duration-200 ${dimmed ? "opacity-40" : "opacity-100"}`}
      >
        <div className={`glow -bottom-72 left-1/2 -translate-x-1/2 ${pendingId === null ? "" : "glow-breathing"}`} aria-hidden />
        {/* Beside the pill rather than in it: a running recording or focus run is a state, not
          * a destination. Both live in the same slot, stacked, so a second chip can never land
          * on top of the first; it steps aside for the prompt bar, which takes the whole width. */}
        {!open && (
          <div className="absolute right-full bottom-2.5 mr-3 flex flex-col items-end gap-2">
            <FocusChip />
            <RecordingChip />
          </div>
        )}
        {sheetOpen && !open && narrow && (
          <DockSheet items={SHEET_ITEMS} icons={ICONS} pathname={pathname} onClose={closeSheet} onNavigate={hideSheet} />
        )}
        {open ? (
          <motion.div {...morph} className="relative w-[calc(100vw-2rem)] max-w-[720px]">
            <PromptBar open onClose={closeBar} initialValue={draft} onDraftChange={setDraft} />
          </motion.div>
        ) : (
          <motion.nav
            {...morph}
            aria-label="Main"
            onPointerMove={magnify.onPointerMove}
            onPointerLeave={magnify.onPointerLeave}
            className="panel relative rounded-full h-16 px-3 flex items-center gap-1"
          >
            {/* The lit top edge that makes the pill read as glass rather than a flat plate. */}
            <span className="pointer-events-none absolute inset-x-8 top-0 h-px bg-linear-to-b from-white/10 to-transparent" aria-hidden />
            {slots.map(({ key, ...slot }, i) => (
              <Fragment key={key}>
                <DockItem {...slot} scale={magnify.scaleAt(i)} />
                {dividers.includes(i) && <span className="w-px h-8 mb-2 shrink-0 bg-hairline-strong" aria-hidden />}
              </Fragment>
            ))}
          </motion.nav>
        )}
      </div>
    </div>
  );
}
