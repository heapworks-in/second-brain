"use client";
import { useEffect, useState, type ReactNode } from "react";
import { TopBar } from "./top-bar";
import { ToastProvider } from "./toasts";
import { Dock } from "../dock/dock";
import { BreakOffer } from "../focus/break-offer";
import { BoxVerdict } from "../focus/box-verdict";

/** The frame every page sits in: breadcrumb bar, rail slot, dock, toasts. */
export function AppShell({ children }: { children: ReactNode }) {
  const [railOpen, setRailOpen] = useState(false);

  // Below 1180 px the rail is an overlay, so Escape has to dismiss it like any other one.
  useEffect(() => {
    if (!railOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setRailOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [railOpen]);

  return (
    <ToastProvider>
      {/* Every child is placed by hand. Auto-placement would put the main column in the
        * leading track whenever the rail slot is `display:none`, and it would then size to
        * max-content instead of filling the row. */}
      <div className="min-h-screen grid grid-cols-[1fr_auto]">
        <div className="col-start-1 relative flex flex-col min-w-0 min-h-screen">
          <TopBar onRail={() => setRailOpen((v) => !v)} railOpen={railOpen} />
          {/* The dock floats over the last rows of the page; the padding leaves it room. */}
          <main className="flex-1 min-w-0 pb-28">{children}</main>
          <Dock />
          {/* Mounted once for the whole app, not per page: a run can finish while the person is
            * anywhere, and the offer that follows it should reach them wherever that is. */}
          <BreakOffer />
          <BoxVerdict />
        </div>
        {railOpen && (
          <button
            type="button"
            aria-label="Close context"
            onClick={() => setRailOpen(false)}
            className="focus-ring fixed inset-0 z-20 bg-black/50 min-[1180px]:hidden"
          />
        )}
        {/* Wide: its own column, pinned under the top bar so it scrolls on its own rather
          * than with the page. Narrow: an overlay over the main column. */}
        <div
          id="rail-slot"
          className={`col-start-2 w-[280px] border-l border-hairline bg-layer-1 min-[1180px]:sticky min-[1180px]:top-12 min-[1180px]:h-[calc(100vh-3rem)] min-[1180px]:self-start min-[1180px]:overflow-hidden max-[1179px]:fixed max-[1179px]:right-0 max-[1179px]:top-12 max-[1179px]:bottom-0 max-[1179px]:z-30 ${railOpen ? "" : "max-[1179px]:hidden"}`}
        />
      </div>
    </ToastProvider>
  );
}
