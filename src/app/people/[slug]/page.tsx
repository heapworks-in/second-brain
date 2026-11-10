import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, Hourglass } from "lucide-react";
import { getDb } from "@/db/client";
import { getPersonBySlug, getPersonTimeline } from "@/domain/people";
import { listTasks } from "@/domain/tasks";
import { daysBetween } from "@/lib/deadline";
import { localDay } from "@/lib/time";
import { serializeItem, serializePerson } from "@/lib/api";
import { PersonEditor } from "@/components/person-editor";
import { TypeIcon } from "@/components/type-icon";
import { formatDate } from "@/lib/format";
import { EmptyState, List, Row, SectionHeading } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function PersonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  const person = getPersonBySlug(db, slug);
  if (!person) notFound();
  const rawTimeline = getPersonTimeline(db, person.id);
  // `getPersonTimeline` already orders newest first, so its own head is the last contact --
  // reused rather than asked for again with a second query, the same rule `listPeople` follows.
  const lastContact = rawTimeline[0]?.createdAt ?? null;
  const meetingCount = rawTimeline.filter((i) => i.type === "meeting").length;
  const timeline = rawTimeline.map((i) => serializeItem(db, i));
  // What I owe this person, longest wait first -- the other way round from the timeline, which is
  // a record of the past. This is the only part of the page that is about the present.
  const today = localDay(new Date().toISOString());
  const owed = listTasks(db, { status: "open", requester: person.id }).sort((a, b) => (a.askedOn ?? "").localeCompare(b.askedOn ?? ""));
  return (
    <div className="w-full px-6 lg:px-8 pt-8 grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-8">
      <PersonEditor key={person.id} initial={serializePerson({ ...person, lastContact, meetingCount }, timeline.length)} />
      <section className="flex flex-col gap-6">
        {owed.length > 0 && (
          <div className="flex flex-col gap-2">
            <SectionHeading count={owed.length}>Waiting on you</SectionHeading>
            <List>
              {owed.map((t) => {
                const days = t.askedOn ? daysBetween(t.askedOn, today) : null;
                return (
                  <Row key={t.id}>
                    <Hourglass className="w-4 h-4 text-fg-faint shrink-0" aria-hidden />
                    <span className="flex-1 truncate text-[13.5px]">{t.title}</span>
                    <span className={`font-mono text-[11px] ${days !== null && days >= 7 ? "text-danger" : days !== null && days >= 3 ? "text-warn" : "text-fg-faint"}`}>
                      {days === null ? "asked" : days === 0 ? "today" : `${days}d`}
                    </span>
                  </Row>
                );
              })}
            </List>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <SectionHeading count={timeline.length}>Timeline</SectionHeading>
          {timeline.length === 0 ? (
            <EmptyState icon={Clock} text="No linked items yet." />
          ) : (
            <List>
              {timeline.map((i) => (
                <Row key={i.id}>
                  <TypeIcon type={i.type} />
                  <Link href={`/items/${i.id}`} className="flex-1 truncate text-[13.5px] hover:text-violet-bright">
                    {i.title}
                  </Link>
                  <span className="font-mono text-[11px] text-fg-faint">{formatDate(i.createdAt)}</span>
                </Row>
              ))}
            </List>
          )}
        </div>
      </section>
    </div>
  );
}
