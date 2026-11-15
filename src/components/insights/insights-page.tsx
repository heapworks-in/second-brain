import Link from "next/link";
import { ArrowUpRight, CircleAlert, CircleCheck, Info } from "lucide-react";
import type { Insight } from "@/domain/insights";

const TONE: Record<Insight["severity"], { icon: typeof Info; className: string; label: string }> = {
  blocked: { icon: CircleAlert, className: "text-danger", label: "Not working" },
  notable: { icon: Info, className: "text-fg-muted", label: "Worth knowing" },
  good: { icon: CircleCheck, className: "text-violet-bright", label: "Working" },
};

/**
 * What the app has noticed, which is not the same thing as what it wants you to decide.
 *
 * The desk asks questions and commits answers. This asks nothing: every line here is a fact that
 * would otherwise have to be dug out of the database by hand, which is exactly how each of these
 * was found. Several turned out to explain why whole features had never produced anything -- the
 * calendar held only holidays, Accessibility had never been granted, the desk had never once been
 * answered. The machinery ran perfectly in every case and nothing said the inputs were missing.
 *
 * Worst first, and "Working" lines are kept rather than hidden: a page that is only ever bad news
 * is a page you stop opening, and then it is no better than the thing it was meant to catch.
 */
export function InsightsPage({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) {
    return (
      <div className="w-full max-w-[52rem] mx-auto px-1 pt-2 sm:pt-5">
        <p className="m-0 text-[13px] text-fg-muted">Nothing worth flagging. Everything that should be arriving is.</p>
      </div>
    );
  }

  const blocked = insights.filter((i) => i.severity === "blocked").length;

  return (
    <div className="flex flex-col gap-4 w-full max-w-[52rem] mx-auto px-1 pt-2 sm:pt-5">
      <p className="m-0 text-[12.5px] text-fg-faint">
        {blocked > 0
          ? `${blocked} ${blocked === 1 ? "thing is" : "things are"} not working. Nothing here asks you to decide anything.`
          : "Nothing here asks you to decide anything — the desk is where that happens."}
      </p>

      <div className="flex flex-col gap-2">
        {insights.map((insight) => {
          const tone = TONE[insight.severity];
          const Icon = tone.icon;
          return (
            <article key={insight.id} className="pane px-3.5 py-3 flex gap-3">
              <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${tone.className}`} aria-hidden />
              <div className="flex flex-col gap-1 min-w-0">
                <h2 className="m-0 text-[14px] font-medium leading-snug text-balance">
                  {insight.headline}
                  <span className="sr-only"> — {tone.label}</span>
                </h2>
                <p className="m-0 text-[12.5px] text-fg-muted">{insight.detail}</p>
                {insight.href && (
                  <Link
                    href={insight.href}
                    className="focus-ring rounded-sm mt-0.5 flex items-center gap-1 self-start text-[12px] text-fg-faint hover:text-fg"
                  >
                    {insight.action ?? "Look"}
                    <ArrowUpRight className="w-3 h-3 shrink-0" aria-hidden />
                  </Link>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
