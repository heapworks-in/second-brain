import { PageHeader, SectionHeading, Kbd } from "@/components/ui";

export const dynamic = "force-static";

interface Shortcut {
  keys: string[];
  does: string;
}

const NAV_SHORTCUTS: Shortcut[] = [
  { keys: ["g", "h"], does: "Home" },
  { keys: ["g", "k"], does: "Desk" },
  { keys: ["g", "d"], does: "Planner" },
  { keys: ["g", "g"], does: "Goals" },
  { keys: ["g", "w"], does: "Weekly Review" },
  { keys: ["g", "i"], does: "Inbox" },
  { keys: ["g", "p"], does: "Projects" },
  { keys: ["g", "a"], does: "Areas" },
  { keys: ["g", "r"], does: "Resources" },
  { keys: ["g", "e"], does: "People" },
  { keys: ["g", "t"], does: "Activity" },
  { keys: ["g", "l"], does: "Library" },
  { keys: ["g", "x"], does: "Archive" },
  { keys: ["g", "s"], does: "Search" },
  { keys: ["g", "c"], does: "Capture" },
  { keys: ["g", "u"], does: "This page" },
];

const GLOBAL_SHORTCUTS: Shortcut[] = [
  { keys: ["⌘", "K"], does: "Open the command palette — every page and action, searchable by name" },
  { keys: ["/"], does: "Jump straight into the search box, from anywhere" },
  { keys: ["c"], does: "Put the caret in the capture bar without leaving the page you're on" },
  { keys: ["⌘", "⇧", "F"], does: "Start a Focus run on the task under the keyboard — press again to stop, or on a different task to switch to it" },
  { keys: ["?"], does: "This page" },
];

function ShortcutRow({ keys, does }: Shortcut) {
  return (
    <li className="hairline-row flex items-center gap-4 px-3 py-2">
      <span className="flex items-center gap-1 shrink-0 w-28">
        {keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </span>
      <span className="text-[13px] text-fg-muted">{does}</span>
    </li>
  );
}

function Topic({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pane p-4 flex flex-col gap-2">
      <SectionHeading>{title}</SectionHeading>
      <div className="flex flex-col gap-2 text-[13.5px] text-fg-muted leading-6">{children}</div>
    </section>
  );
}

export default function HelpPage() {
  return (
    <div className="w-full max-w-3xl mx-auto px-6 lg:px-8 pt-8 pb-16 flex flex-col gap-6">
      <PageHeader title="Help" meta="What everything does, and how to get around without the mouse." />

      <section className="pane p-4 flex flex-col gap-3">
        <SectionHeading>Keyboard shortcuts</SectionHeading>
        <div className="grid sm:grid-cols-2 gap-x-6">
          <ul className="list-none m-0 p-0">
            {GLOBAL_SHORTCUTS.map((s, i) => (
              <ShortcutRow key={i} {...s} />
            ))}
          </ul>
          <ul className="list-none m-0 p-0">
            {NAV_SHORTCUTS.map((s, i) => (
              <ShortcutRow key={i} {...s} />
            ))}
          </ul>
        </div>
        <p className="text-[12px] text-fg-faint m-0">
          The <Kbd>g</Kbd> shortcuts are a chord: press <Kbd>g</Kbd>, then the letter, within about a second. None of these fire while
          you&apos;re typing in a field.
        </p>
      </section>

      <Topic title="Capture">
        <p className="m-0">
          Press <Kbd>c</Kbd> from anywhere, or open <Kbd>g</Kbd> <Kbd>c</Kbd>, to get a bar for a quick note, a pasted link, or a dropped
          file. Nothing here asks where it belongs yet — everything captured lands in the Inbox, unfiled, until you decide.
        </p>
      </Topic>

      <Topic title="Organize — Projects, Areas, Resources, Archive">
        <p className="m-0">
          Everything you keep lives in one of four kinds of place, split by what it&apos;s for rather than what it is:
        </p>
        <ul className="pl-5 m-0 flex flex-col gap-1 list-disc">
          <li><strong className="text-fg font-medium">Projects</strong> have an end — something you&apos;re working toward finishing.</li>
          <li><strong className="text-fg font-medium">Areas</strong> don&apos;t end — a standard you maintain for as long as it matters.</li>
          <li><strong className="text-fg font-medium">Resources</strong> are reference material — notes and links you&apos;re keeping for later, not acting on now.</li>
          <li><strong className="text-fg font-medium">Archive</strong> is where a closed project or a dead area goes, out of the way but never deleted.</li>
        </ul>
        <p className="m-0">
          <strong className="text-fg font-medium">Library</strong> is the catalog of everything, filterable by type, status, tag, date,
          or which of the above it&apos;s filed to.
        </p>
      </Topic>

      <Topic title="Desk">
        <p className="m-0">
          One decision at a time (<Kbd>g</Kbd> <Kbd>k</Kbd>), from things the app already knows but never used to ask about: a meeting
          starting soon with nothing written against it, a task that has overrun its estimate, a commitment from a meeting that never
          became a task, a prediction past its date, a capture with no home, a standing call on a recurring meeting that nothing has
          confirmed in months.
        </p>
        <p className="m-0">
          <Kbd>⏎</Kbd> takes the answer the card names, <Kbd>.</Kbd> puts it off for a week, and <Kbd>n</Kbd> means never — which quietly
          sinks that whole kind of card down the list, so the desk gets quieter in the shape of your own judgement. Every answer commits
          at once and offers to undo for eight seconds, and there are never more than seven waiting: a queue you can clear is one you
          keep clearing.
        </p>
      </Topic>

      <Topic title="Planner">
        <p className="m-0">
          Day and Week views for time-blocking: drag a task onto the timeline to give it a slot, or let <strong className="text-fg font-medium">Fill the day</strong> place
          your open tasks into whatever&apos;s actually free. The capacity line at the top counts down real minutes left today —
          accounting for meetings, and for how long things have actually taken you before, not just your estimate.
        </p>
        <p className="m-0">
          A <strong className="text-fg font-medium">Focus run</strong> (<Kbd>⌘</Kbd> <Kbd>⇧</Kbd> <Kbd>F</Kbd>) times a single sitting on one
          task, so the planner learns from what really happened, not what you guessed.
        </p>
      </Topic>

      <Topic title="Goals">
        <p className="m-0">
          Set a goal for the quarter or the year, then link the projects and tasks that move it. Progress is computed from what&apos;s
          actually done among the linked work — never a number you type in by hand. A goal that hasn&apos;t moved in a while is called
          out as stalled, so it can&apos;t quietly drop off your radar.
        </p>
      </Topic>

      <Topic title="Weekly Review">
        <p className="m-0">
          A short guided ritual to close the loop on the week: what finished, what&apos;s carrying over, and what you&apos;re walking
          into next. Your answers are searchable afterward, the same as any other note.
        </p>
      </Topic>

      <Topic title="Meetings">
        <p className="m-0">
          Meetings get recorded automatically when they start, or on demand with <strong className="text-fg font-medium">Record now</strong>.
          Each one carries a local decision — <strong className="text-fg font-medium">Going</strong>, <strong className="text-fg font-medium">Maybe</strong>,
          or <strong className="text-fg font-medium">Not going</strong> — that decides whether it blocks your calendar and counts against
          your day&apos;s capacity. This decision is only ever recorded here; it&apos;s never sent to the organizer or the calendar
          server.
        </p>
        <p className="m-0">
          File a meeting to a project from its own page, or from the project&apos;s Meetings section. The{" "}
          <strong className="text-fg font-medium">Audit</strong> page shows what a recurring series has actually cost over the last 90
          days — occurrences, hours, attendance, and what came out of it — as plain facts, deliberately with no score or ranking.
        </p>
      </Topic>

      <Topic title="Distill">
        <p className="m-0">
          For notes, links, and files: once something has gone quiet for a while, the app tries to boil it down to a short gist and a
          handful of key quotes pulled directly from what you wrote — never invented, never paraphrased into something you didn&apos;t
          say. You choose <strong className="text-fg font-medium">Keep</strong> or <strong className="text-fg font-medium">Not useful</strong>;
          either way, your original note is never touched.
        </p>
        <p className="m-0">
          This runs fully offline and does nothing until a small local model is set up — no account, no ongoing cost. Browse everything
          you&apos;ve kept from Library&apos;s Distilled filter.
        </p>
      </Topic>
    </div>
  );
}
