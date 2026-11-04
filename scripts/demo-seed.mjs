#!/usr/bin/env node
/**
 * Fills a throwaway data directory with a plausible week of work, so the app can be
 * photographed without photographing anybody's real life.
 *
 * The screenshots on the site are of the actual running app, not mockups. The only honest way
 * to take them is against invented data: this repo is public, the release dmg ships the whole
 * payload, and a screenshot of the real database would publish meeting titles, people and
 * browsing history along with it. Everything below is fiction.
 *
 *   DEMO=/tmp/sb-demo
 *   rm -rf "$DEMO" && mkdir -p "$DEMO"
 *   ln -s "$HOME/Library/Application Support/second-brain/models" "$DEMO/models"   # don't re-download
 *   SB_DATA_DIR="$DEMO" npx next start -p 4142 &                                   # creates + migrates the db
 *   curl -sf http://localhost:4142/api/home >/dev/null && kill %1                  # let it migrate, then stop
 *   node scripts/demo-seed.mjs "$DEMO"
 *   SB_DATA_DIR="$DEMO" npx next start -p 4142                                     # photograph this one
 *
 * Dates are relative to the day it runs, so the planner, the capacity line and "today" are
 * never stale in a screenshot taken months later.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("usage: node scripts/demo-seed.mjs <data-dir>");
  process.exit(1);
}
const dbPath = path.join(dataDir, "brain.db");
if (!fs.existsSync(dbPath)) {
  console.error(`no database at ${dbPath} -- start the app once with SB_DATA_DIR set so it migrates`);
  process.exit(1);
}

const touchOnly = process.argv.includes("--touch");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// Only needed if something here ever deletes a chunk (the delete trigger touches chunks_vec).
try {
  require("sqlite-vec").load(db);
} catch {
  /* inserts don't need it */
}

/* ---------------------------------------------------------------- time */

if (touchOnly) {
  const state = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'activity_helper_state'").get()?.value ?? "{}");
  state.lastSeen = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('activity_helper_state', ?)").run(JSON.stringify(state));
  console.log("refreshed the helper heartbeat");
  process.exit(0);
}

// Nothing is committed unless the whole world lands: a half-seeded directory is worse than none.
db.exec("BEGIN");

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const day = (offset = 0) => {
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** A naive local stamp, the format task blocks and calendar events are stored in. */
const at = (offset, hhmm) => `${day(offset)}T${hhmm}:00`;
/** A real instant, the format created_at and the activity helper use. */
const iso = (offset, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(now);
  d.setDate(d.getDate() + offset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const TODAY = day(0);
/** HH:MM a given number of minutes from now, rounded to five, so the demo day always has
 *  something in progress whatever time the screenshots are taken. */
const clockFromNow = (deltaMinutes) => {
  const d = new Date(now.getTime() + deltaMinutes * 60_000);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/* ---------------------------------------------------------------- helpers */

const insert = (table, row) => {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
  return db.prepare(sql).run(keys.map((k) => (typeof row[k] === "boolean" ? (row[k] ? 1 : 0) : row[k]))).lastInsertRowid;
};

const container = (kind, name, slug, extra = {}) =>
  insert("containers", {
    kind,
    name,
    slug,
    description: "",
    status: "active",
    goal: "",
    standard: "",
    next_steps: "",
    sort_order: 0,
    created_at: iso(-60, "09:00"),
    updated_at: iso(-1, "17:00"),
    ...extra,
  });

const item = (type, title, extra = {}) =>
  insert("items", {
    type,
    title,
    body: "",
    status: "ready",
    extracted_text: "",
    meta: "{}",
    pinned: 0,
    created_at: iso(-3, "10:00"),
    updated_at: iso(-3, "10:00"),
    ...extra,
  });

const task = (title, extra = {}) =>
  insert("tasks", {
    title,
    notes: "",
    status: "open",
    priority: "normal",
    sort_order: 0,
    created_at: iso(-5, "09:00"),
    updated_at: iso(-1, "09:00"),
    ...extra,
  });

/** One searchable chunk per item, plus the embed job that gives it a vector. */
const indexItem = (id, text) => {
  if (!text.trim()) return;
  insert("chunks", { item_id: id, ordinal: 0, text: text.slice(0, 1200) });
  insert("jobs", {
    type: "embed",
    payload: JSON.stringify({ itemId: id }),
    status: "queued",
    attempts: 0,
    run_after: iso(0, "00:01"),
    item_id: id,
    created_at: iso(0, "00:01"),
    updated_at: iso(0, "00:01"),
  });
};

/* ---------------------------------------------------------------- people and places */

const P = {
  postgres: container("project", "Postgres migration", "postgres-migration", {
    goal: "Every service reading and writing Postgres, with MySQL switched off and the backfill verified.",
    deadline: day(17),
    next_steps: "Dry-run the cutover on staging with production-sized data.",
  }),
  billing: container("project", "Billing v2", "billing-v2", {
    goal: "Usage-based invoices generated, reviewed and sent without anyone opening a spreadsheet.",
    deadline: day(38),
  }),
  hiring: container("project", "Hiring: platform engineer", "hiring-platform-engineer", {
    goal: "An offer out to someone who has run a migration this size before.",
    deadline: day(27),
  }),
  team: container("area", "Team health", "team-health", {
    standard: "Everyone has a 1:1 at least every fortnight, and nobody is the only person who understands something.",
  }),
  oncall: container("area", "On-call", "on-call", {
    standard: "Under four pages a week, and every page that fires has a runbook worth opening.",
  }),
  dist: container("resource", "Distributed systems", "distributed-systems", { category: "research" }),
  interviewing: container("resource", "Interviewing", "interviewing", { category: "reference" }),
};

const person = (name, slug, organization, team, title) =>
  insert("people", {
    name,
    slug,
    profile: "",
    organization,
    team,
    title,
    created_at: iso(-90, "09:00"),
    updated_at: iso(-7, "09:00"),
  });

const PEOPLE = {
  priya: person("Priya Raman", "priya-raman", "Meridian", "Platform", "Staff Engineer"),
  marcus: person("Marcus Okafor", "marcus-okafor", "Meridian", "Reliability", "SRE"),
  dana: person("Dana Whitfield", "dana-whitfield", "Meridian", "Billing", "Product Manager"),
  tom: person("Tom Lindqvist", "tom-lindqvist", "Meridian", "Platform", "Engineering Manager"),
  ines: person("Inés Costa", "ines-costa", "Meridian", "Design", "Product Designer"),
};

/* ---------------------------------------------------------------- the meeting that carries the product */

const transcript = [
  [0, 6, "Right, let's do the cutover properly this time. Priya, where did the backfill get to overnight?"],
  [7, 15, "It finished. Eleven hours for the whole of orders, which is two hours slower than the staging run, but it finished clean."],
  [16, 24, "Two hours slower on the same hardware? That's the index build on order_items, I'd bet."],
  [25, 33, "It is. I watched it. The index build is about ninety minutes of that on its own, and there's nothing clever we can do about it."],
  [34, 41, "So the window is twelve hours, not ten. That rules out doing it on a weeknight."],
  [42, 52, "Saturday then. If we start at eight in the evening we're done before anyone opens a laptop on Sunday, and we still have Sunday as the day we can roll back in."],
  [53, 60, "I want to be clear about what rolling back means at that point. Once we've cut writes over, rolling back loses whatever came in after."],
  [61, 72, "It does. Which is why I'd rather we kept dual writes on for the first week. It costs us a bit of latency on the write path, maybe four or five milliseconds, and it means a rollback is a config change instead of a restore."],
  [73, 79, "Four milliseconds on p50 or p99? Because those are very different conversations."],
  [80, 88, "p99. p50 barely moves. I measured it on staging on Tuesday with production-shaped traffic."],
  [89, 95, "Then yes, dual writes for a week. Cheap insurance. Dana, does anything in billing care?"],
  [96, 107, "Billing reads the replica, so as long as the replica is still there on the Monday we're fine. What I do care about is the invoice run on the first of the month -- if the cutover is the Saturday before that, I want a day between them."],
  [108, 115, "The twenty-first is two weekends before the first. That's clear."],
  [116, 124, "Then let's say the twenty-first, eight in the evening, dual writes stay on until the following Saturday."],
  [125, 134, "I'll write the runbook this week and we'll walk it in next week's sync. Marcus, can you do the pager rota for that night?"],
  [135, 141, "Yes. I'll take the first half and put Priya on the second, and I'll write the rollback steps into the runbook as well."],
  [142, 150, "Last thing -- who tells support? They were the last to know in the Redis migration and I'd rather not repeat that."],
  [151, 158, "I'll send them the window and the rollback plan on Monday, and I'll book twenty minutes with their team lead."],
];

const heroSummary = {
  summary:
    "The team walked through the Postgres cutover now that the overnight backfill has completed. The backfill took eleven hours, two hours longer than the staging run, with roughly ninety minutes of that spent building the index on order_items -- which pushes the required window past what a weeknight allows. The discussion settled on a Saturday evening start, dual writes kept on for a week afterwards so a rollback stays a configuration change rather than a restore, and a date chosen to leave clear air before the monthly invoice run.",
  decisions: [
    "Cutover will run on Saturday the 21st, starting at 20:00 -- a twelve-hour window, which rules out a weeknight.",
    "Dual writes stay on for the week following the cutover, at a measured cost of 4-5ms on write p99 (p50 effectively unchanged).",
    "The date was chosen to leave two weekends before the monthly invoice run, at Billing's request.",
    "Rollback after the write cutover is accepted as lossy; dual writes are the mitigation rather than a restore plan.",
  ],
  proposed_actions: [
    { title: "Write the cutover runbook and walk it at next week's sync", notes: "Priya, before next Thursday" },
    { title: "Set the pager rota for cutover night", notes: "Marcus -- first half himself, second half Priya" },
    { title: "Add rollback steps to the runbook", notes: "Marcus" },
    { title: "Brief the support team on the window and the rollback plan", notes: "Tom, Monday -- plus 20 minutes with their team lead" },
  ],
};

const heroText = transcript.map((s) => s[2]).join(" ");
const hero = item("meeting", "Platform sync — Postgres cutover", {
  container_id: P.postgres,
  body: [
    `**When:** ${TODAY} 11:00 to 11:45`,
    "**Who:** 4 attendees",
    "",
    "## Notes",
    "",
    "Backfill finished but two hours over the staging run -- index build on order_items, ~90 min of it.",
    "Twelve-hour window means a weekend, not a weeknight.",
    "Dual writes keep rollback as a config change. Dana needs clear air before the invoice run.",
    "",
    "## Actions",
    "",
    "- [x] Pick the date and say it out loud",
    "- [ ] Tell support before anyone else does",
  ].join("\n"),

  extracted_text: heroText,
  created_at: iso(0, "11:00"),
  updated_at: iso(0, "11:44"),
  meta: JSON.stringify({
    transcript: transcript.map(([start, end, text]) => ({ start, end, text })),
    final_transcript_ready: true,
    recording: { startedAt: iso(0, "11:00"), endedAt: iso(0, "11:42"), wavPath: "meetings/demo-platform-sync.wav", state: "done", autoStarted: true },
    summary: heroSummary,
    acceptedActions: [0, 1],
  }),
});
indexItem(hero, heroText);
for (const id of [PEOPLE.priya, PEOPLE.marcus, PEOPLE.dana, PEOPLE.tom]) insert("item_people", { item_id: hero, person_id: id });

const scopeTranscript = [
  [0, 7, "We are not going to have proration ready for the launch, and I'd rather say that now than in three weeks."],
  [8, 16, "What's the actual blocker? Last I heard it was the mid-cycle plan change, not proration itself."],
  [17, 27, "It's both, but they're the same bug really. A plan change mid-cycle produces two line items and we can only attribute one of them to a usage window."],
  [28, 34, "How many customers change plan mid-cycle in a month? Do we know, rather than guess?"],
  [35, 43, "Eleven last month. Out of nine hundred. And nine of those eleven were upgrades we'd have billed the higher rate for anyway."],
  [44, 52, "Then we launch without it and handle those by hand. Eleven invoices a month is an afternoon, not a project."],
  [53, 60, "I'll take that, as long as it's written down that it's deliberate and there's a date on fixing it."],
  [61, 68, "First quarter. I'll put it in the goal as a linked project so it doesn't quietly disappear."],
];
const scopeText = scopeTranscript.map((s) => s[2]).join(" ");
const scope = item("meeting", "Billing v2 — what ships and what doesn't", {
  container_id: P.billing,
  body: [
    `**When:** ${day(-1)} 15:00 to 15:45`,
    "**Who:** 3 attendees",
    "",
    "## Notes",
    "",
    "Eleven customers a month, nine of them upgrades. Not a project.",
    "Say it is deliberate, in writing, with a date.",
    "",
    "## Actions",
    "",
    "- [ ] Write the manual process down before launch",
  ].join("\n"),
  extracted_text: scopeText,
  created_at: iso(-1, "15:00"),
  updated_at: iso(-1, "15:34"),
  meta: JSON.stringify({
    transcript: scopeTranscript.map(([start, end, text]) => ({ start, end, text })),
    final_transcript_ready: true,
    recording: { startedAt: iso(-1, "15:00"), endedAt: iso(-1, "15:31"), wavPath: "meetings/demo-billing-scope.wav", state: "done", autoStarted: true },
    summary: {
      summary:
        "Proration will not be ready for the Billing v2 launch. The underlying problem is attributing a mid-cycle plan change to a usage window, which produces two line items the system can only reconcile for one of them. Eleven of roughly nine hundred customers changed plan mid-cycle last month, nine of those upgrades, so the meeting chose to launch without it and handle the affected invoices by hand until a first-quarter fix.",
      decisions: [
        "Billing v2 launches without proration; the affected invoices are handled manually.",
        "The gap is recorded deliberately, with a first-quarter date on the fix rather than an open end.",
        "The fix is tracked as a project linked to the billing goal, so it stays visible.",
      ],
      proposed_actions: [
        { title: "Write up the proration gap and the manual process for it", notes: "Dana, before launch" },
        { title: "Link the proration fix to the Billing goal as a Q1 project", notes: "Tom" },
      ],
    },
  }),
});
indexItem(scope, scopeText);
for (const id of [PEOPLE.dana, PEOPLE.tom, PEOPLE.ines]) insert("item_people", { item_id: scope, person_id: id });

const oneToOneText =
  "Priya raised that she is the only person who has run the backfill end to end, and that this makes her nervous about taking leave in December. We agreed to pair Marcus through a full dry run before the cutover so there are two people who have done it. She also wants to spend more time on the query planner work and less on review; agreed to cut her review load in half after the migration ships.";
const oneToOne = item("meeting", "1:1 — Priya", {
  container_id: P.team,
  extracted_text: oneToOneText,
  created_at: iso(-2, "09:30"),
  updated_at: iso(-2, "10:02"),
  meta: JSON.stringify({
    transcript: [
      [0, 9, "Before anything else -- I'm the only one who has run the backfill end to end, and that's a problem if I want to take any time off in December."],
      [10, 18, "Agreed, and that's on me rather than you. What would it take for Marcus to have done it once as well?"],
      [19, 27, "A full dry run on staging, with me watching rather than driving. Half a day, and we need it before the cutover anyway."],
      [28, 36, "Then let's book it this week. What else -- you said you wanted to talk about where your time goes."],
      [37, 48, "Review, mostly. I'm doing about ten hours a week of it and it's crowding out the query planner work, which is the thing I'm actually best at."],
      [49, 56, "After the migration ships I'll cut that in half and move the rest to Tom's side of the team."],
    ].map(([start, end, text]) => ({ start, end, text })),
    final_transcript_ready: true,
    recording: { startedAt: iso(-2, "09:30"), endedAt: iso(-2, "10:01"), wavPath: "meetings/demo-1-1-priya.wav", state: "done", autoStarted: false },
    summary: {
      summary:
        "Priya raised a single-point-of-failure risk: she is the only person who has run the backfill end to end, which makes taking December leave difficult. The fix agreed was a full staging dry run with Marcus driving and Priya watching, which the cutover needs regardless. She also asked to shift time away from review -- roughly ten hours a week -- towards query planner work, and that was agreed for after the migration ships.",
      decisions: [
        "Marcus runs a full backfill dry run on staging with Priya observing, before the cutover.",
        "Priya's review load halves once the migration ships, with the remainder moving to Tom's side of the team.",
      ],
      proposed_actions: [{ title: "Book the staging dry run with Marcus driving", notes: "This week, half a day" }],
    },
  }),
});
indexItem(oneToOne, oneToOneText);
insert("item_people", { item_id: oneToOne, person_id: PEOPLE.priya });

/* ---------------------------------------------------------------- notes, links, the inbox */

const notes = [
  [
    "Cutover runbook (draft)",
    P.postgres,
    "Pre-flight: confirm replica lag under one second, confirm the backfill checksum job finished green, confirm nobody has a long-running migration open. Cutover: stop writers, wait for drain, flip the connection string, start writers against Postgres with dual writes to MySQL still on. Verify: run the order reconciliation query for the last hour and compare counts. Rollback: flip the connection string back; anything written in between is still in MySQL because dual writes never stopped.",
  ],
  [
    "What actually went wrong in the Redis migration",
    P.postgres,
    "Three things, none of them technical. Support found out from a customer rather than from us. The rollback plan existed but nobody had read it, so the first ten minutes went on finding it. And we started at 2am, which meant the people who knew the system best were the least awake people in the room. The fix for all three is the same: do it earlier in the evening, walk the runbook out loud the week before, and tell support first.",
  ],
  [
    "Interview loop — platform engineer",
    P.hiring,
    "Four conversations, not five. A systems design hour that uses our actual migration as the problem, a debugging session on a real incident with the logs we had at the time, a pairing session on a small change in a codebase they have never seen, and a conversation about how they work with people who disagree with them. No algorithm puzzles: nothing in this job has ever looked like one.",
  ],
  [
    "On-call handover — week notes",
    P.oncall,
    "Four pages this week, three of them the same disk alert on the reporting replica firing at different thresholds. The runbook for it says to extend the volume, which nobody can do without being paged again an hour later. Root cause is the retention job not running since the credentials rotated. Fixed, but the alert should have told us that.",
  ],
  [
    "Why we are leaving MySQL",
    P.dist,
    "Not performance. The honest reason is that three of the things we want to build next -- partial indexes on the orders table, jsonb on the event payloads, and range types for the billing windows -- are each a workaround in MySQL and a line of schema in Postgres. We are not migrating to go faster, we are migrating to stop writing workarounds, and the plan should say so rather than dressing it up in benchmarks.",
  ],
];
for (const [title, cid, body] of notes) {
  const id = item("note", title, { container_id: cid, body, extracted_text: body, created_at: iso(-4, "14:00"), updated_at: iso(-2, "11:00") });
  indexItem(id, body);
}

/** One note carrying a finished distillation, so the Distill surface has something to show. */
const distilled = (() => {
  const body =
    "Spent the morning reading the logical replication docs properly rather than skimming them. The thing I had wrong: a publication does not have to cover the whole database, and a subscription can be created with copy_data false when the backfill has already been done by other means. That is exactly our case -- we are backfilling with the bulk loader, so the subscription only has to carry the tail. It also means we can bring tables over one at a time and verify each one before adding the next, rather than one enormous switch. The catch is sequences: logical replication does not carry them, so every sequence has to be set by hand on the Postgres side before the cutover or the first insert collides.";
  const id = item("note", "Logical replication, read properly", {
    container_id: P.postgres,
    body,
    extracted_text: body,
    created_at: iso(-6, "09:20"),
    updated_at: iso(-5, "18:00"),
    meta: JSON.stringify({
      distillation: {
        gist: "Logical replication can carry just the tail after a bulk backfill, table by table, which turns one enormous switch into a sequence of verifiable steps. Sequences are the catch: they are not replicated and must be set by hand before the cutover.",
        quotes: [
          "a subscription can be created with copy_data false when the backfill has already been done by other means",
          "we can bring tables over one at a time and verify each one before adding the next, rather than one enormous switch",
          "logical replication does not carry them, so every sequence has to be set by hand on the Postgres side before the cutover or the first insert collides",
        ],
        model: "Qwen2.5-0.5B-Instruct",
        distilledAt: iso(-5, "18:02"),
        kept: true,
      },
    }),
  });
  indexItem(id, body);
  return id;
})();

const links = [
  ["Logical replication — PostgreSQL docs", "https://www.postgresql.org/docs/current/logical-replication.html", P.dist, "Logical replication is a method of replicating data objects and their changes, based upon their replication identity. We use the term logical in contrast to physical replication, which uses exact block addresses and byte-by-byte replication."],
  ["Use The Index, Luke — a guide to database performance", "https://use-the-index-luke.com/", P.dist, "An index is a distinct structure in the database that is built using the create index statement. It requires its own disk space and holds a copy of the indexed table data. That means that an index is pure redundancy."],
  ["How to structure a debugging interview", "https://example.com/debugging-interview", P.interviewing, "The best signal comes from watching someone work with incomplete information. Give them the logs you actually had at the time, not a cleaned-up version, and let them say out loud what they would look at next."],
];
for (const [title, url, cid, text] of links) {
  const id = item("link", title, { container_id: cid, source_url: url, extracted_text: text, created_at: iso(-8, "20:00"), updated_at: iso(-8, "20:01") });
  indexItem(id, text);
}

/** Unfiled: what the Inbox is for. */
const inbox = [
  ["note", "Ask Dana whether the invoice run can move a day", "", null],
  ["link", "Zero-downtime schema changes at scale", "https://example.com/zero-downtime-schema", "Every schema change that holds a lock is an outage waiting for enough traffic. The pattern that scales is expand, migrate, contract: add the new column, write both, backfill, read the new one, drop the old."],
  ["note", "Idea: the runbook should be a checklist in the app, not a doc nobody opens", "The runbook is only useful if it is open during the thing it describes. A document in a wiki is not open during the thing it describes.", null],
  ["file", "Q3-infrastructure-spend.pdf", "", null],
];
const inboxTimes = [[iso(-1, "18:40")], [iso(-1, "21:05")], [iso(0, "07:55")], [iso(-2, "16:20")]];
inbox.forEach(([type, title, textOrBody, url], i) => {
  const id = item(type, title, {
    source_url: url ?? null,
    body: type === "note" ? textOrBody : "",
    extracted_text: type === "link" ? textOrBody : textOrBody,
    mime_type: type === "file" ? "application/pdf" : null,
    created_at: inboxTimes[i][0],
    updated_at: inboxTimes[i][0],
  });
  indexItem(id, textOrBody || title);
});

/* ---------------------------------------------------------------- tasks, the plan, the day */

const T = {};
T.runbook = task("Write the cutover runbook and walk it at next week's sync", {
  container_id: P.postgres,
  source_item_id: hero,
  notes: "Priya, before next Thursday",
  estimate_minutes: 90,
  priority: "high",
  due_date: day(3),
  created_at: iso(0, "11:46"),
});
T.rota = task("Set the pager rota for cutover night", {
  container_id: P.postgres,
  source_item_id: hero,
  notes: "Marcus -- first half himself, second half Priya",
  estimate_minutes: 20,
  created_at: iso(0, "11:46"),
});
T.dryrun = task("Book the staging dry run with Marcus driving", { container_id: P.team, source_item_id: oneToOne, estimate_minutes: 15, priority: "high", due_date: day(1) });
T.sequences = task("Set every sequence by hand on the Postgres side", { container_id: P.postgres, estimate_minutes: 45, notes: "Logical replication does not carry them." });
T.reconcile = task("Write the order reconciliation query the cutover verifies with", { container_id: P.postgres, estimate_minutes: 60 });
T.support = task("Brief support on the cutover window", { container_id: P.postgres, estimate_minutes: 30, due_date: day(4) });
T.proration = task("Write up the proration gap and the manual process", { container_id: P.billing, source_item_id: scope, estimate_minutes: 45, due_date: day(2) });
T.invoice = task("Dry-run the first usage-based invoice end to end", { container_id: P.billing, estimate_minutes: 120, priority: "high" });
T.loop = task("Book the four interview slots for next week", { container_id: P.hiring, estimate_minutes: 25, due_date: day(1) });
T.scorecard = task("Rewrite the scorecard so it scores the loop we actually run", { container_id: P.hiring, estimate_minutes: 50 });
T.retention = task("Add an alert for the retention job not running", { container_id: P.oncall, estimate_minutes: 40 });
T.oneonones = task("Catch up the two 1:1s that slipped last week", { container_id: P.team, estimate_minutes: 60, priority: "high" });

T.backfillDone = task("Watch the overnight backfill and record where the time went", {
  container_id: P.postgres,
  status: "done",
  estimate_minutes: 60,
  completed_at: iso(0, "09:48"),
});
T.replicaDone = task("Confirm replica lag stays under a second during the backfill", { container_id: P.postgres, status: "done", estimate_minutes: 30, completed_at: iso(0, "10:25") });
T.specDone = task("Send the migration spec to the team for comment", { container_id: P.postgres, status: "done", estimate_minutes: 45, completed_at: iso(-1, "16:40") });
T.pagesDone = task("Close out the three duplicate disk pages", { container_id: P.oncall, status: "done", estimate_minutes: 35, completed_at: iso(-1, "11:20") });

/**
 * Three weeks of finished work. The planner's "at your pace" figure needs at least eight tasks
 * that carry both an estimate and a timed run (DRIFT_MIN_PAIRS in src/lib/drift.ts), and a demo
 * that cannot show that figure cannot show the one thing the planner does that a calendar does
 * not.
 */
const history = [
  ["Split the orders table migration into verifiable steps", P.postgres, 90, 115, -3],
  ["Measure dual-write latency on staging", P.postgres, 60, 75, -4],
  ["Rewrite the disk alert so it names the retention job", P.oncall, 45, 40, -5],
  ["First pass at the usage-based invoice query", P.billing, 120, 170, -8],
  ["Screen four platform engineer applications", P.hiring, 60, 55, -9],
  ["Write the incident review for the Redis migration", P.oncall, 90, 125, -10],
  ["Pair with Marcus on the backfill tooling", P.team, 120, 110, -11],
  ["Cost the index build on order_items", P.postgres, 30, 50, -12],
  ["Draft the Billing v2 launch note", P.billing, 45, 60, -15],
  ["Clear the on-call handover backlog", P.oncall, 60, 65, -16],
];
for (const [title, cid, estimate, actual, dayOffset] of history) {
  const id = task(title, {
    container_id: cid,
    status: "done",
    estimate_minutes: estimate,
    completed_at: iso(dayOffset, "16:30"),
    created_at: iso(dayOffset - 2, "09:00"),
    updated_at: iso(dayOffset, "16:30"),
  });
  insert("focus_runs", {
    task_id: id,
    started_at: iso(dayOffset, "15:00"),
    ended_at: iso(dayOffset, "16:30"),
    planned_minutes: estimate,
    actual_minutes: actual,
    outcome: "completed",
  });
}

/** Today's timeline: what is already done sits behind the clock, the rest ahead of it. */
const blocks = [
  [T.backfillDone, "09:00", 60],
  [T.replicaDone, "10:00", 30],
  [T.runbook, "13:30", 60],
  [T.proration, "14:30", 45],
  [T.reconcile, "16:00", 60],
];
for (const [taskId, hhmm, minutes] of blocks) insert("task_blocks", { task_id: taskId, starts_at: at(0, hhmm), minutes });
insert("task_blocks", { task_id: T.invoice, starts_at: at(1, "09:30"), minutes: 90 });
insert("task_blocks", { task_id: T.loop, starts_at: at(1, "11:30"), minutes: 25 });
insert("task_blocks", { task_id: T.scorecard, starts_at: at(2, "14:00"), minutes: 50 });
insert("task_blocks", { task_id: T.retention, starts_at: at(3, "10:00"), minutes: 40 });

// A run that has not ended is a live one: the Home "Now" card and the planner both read it.
insert("task_blocks", { task_id: T.reconcile, starts_at: at(0, clockFromNow(-20)), minutes: 60 });
insert("focus_runs", { task_id: T.reconcile, started_at: iso(0, clockFromNow(-20)), planned_minutes: 45 });

const plan = [T.runbook, T.proration, T.reconcile, T.dryrun, T.oneonones];
plan.forEach((taskId, i) => insert("daily_plan_entries", { date: TODAY, task_id: taskId, sort_order: i, created_at: iso(0, "08:40") }));

insert("focus_runs", { task_id: T.backfillDone, started_at: iso(0, "09:02"), ended_at: iso(0, "09:48"), planned_minutes: 45, actual_minutes: 46, outcome: "completed" });
insert("focus_runs", { task_id: T.replicaDone, started_at: iso(0, "10:03"), ended_at: iso(0, "10:25"), planned_minutes: 25, actual_minutes: 22, outcome: "completed" });
insert("focus_runs", { task_id: T.specDone, started_at: iso(-1, "16:00"), ended_at: iso(-1, "16:40"), planned_minutes: 45, actual_minutes: 40, outcome: "completed" });

/* ---------------------------------------------------------------- the calendar */

const event = (externalId, title, dayOffset, from, to, extra = {}) =>
  insert("calendar_events", {
    external_id: externalId,
    title,
    starts_at: at(dayOffset, from),
    ends_at: at(dayOffset, to),
    attendees: 4,
    has_call_link: 1,
    day: day(dayOffset),
    organizer: "Tom Lindqvist",
    attendee_names: JSON.stringify(["Priya Raman", "Marcus Okafor", "Dana Whitfield", "Tom Lindqvist"]),
    location: "",
    join_url: "https://meet.example.com/platform-sync",
    notes: "",
    all_day: 0,
    status: "accepted",
    calendar_title: "Work",
    source: "eventkit",
    no_record: 0,
    ...extra,
  });

event("demo-standup-today", "Platform standup", 0, "09:30", "09:45", { attendees: 6, series_id: "feed:standup", decision: "going" });
event("demo-sync-today", "Platform sync — Postgres cutover", 0, "11:00", "11:45", { series_id: "feed:platform-sync", item_id: hero, container_id: P.postgres, decision: "going" });
event("demo-1-1-today", "1:1 — Marcus", 0, "15:00", "15:30", { attendees: 2, series_id: "feed:1-1-marcus", attendee_names: JSON.stringify(["Marcus Okafor"]), container_id: P.team });
event("demo-allhands", "All hands", 0, "16:30", "17:30", { attendees: 40, series_id: "feed:all-hands", decision: "maybe", decision_note: "Watching the recording unless the migration comes up." });
event("demo-sync-tomorrow", "Billing weekly", 1, "10:00", "10:45", { series_id: "feed:billing-weekly", container_id: P.billing });
event("demo-interview-tomorrow", "Interview — systems design", 1, "14:00", "15:00", { attendees: 3, series_id: "feed:interview", container_id: P.hiring });

const scopeEvent = event("demo-billing-scope", "Billing v2 — what ships and what doesn't", -1, "15:00", "15:45", {
  attendees: 3,
  series_id: "feed:billing-weekly",
  item_id: scope,
  container_id: P.billing,
  attendee_names: JSON.stringify(["Dana Whitfield", "Tom Lindqvist", "Inés Costa"]),
});
const oneToOneEvent = event("demo-1-1-priya", "1:1 — Priya", -2, "09:30", "10:00", {
  attendees: 2,
  series_id: "feed:1-1-priya",
  item_id: oneToOne,
  container_id: P.team,
  attendee_names: JSON.stringify(["Priya Raman"]),
});
const heroEvent = db.prepare("SELECT id FROM calendar_events WHERE external_id = 'demo-sync-today'").get().id;
// `captureMeeting` writes this link both ways; written by hand here, it has to be set both ways too.
const linkEvent = db.prepare("UPDATE items SET meta = json_set(meta, '$.calendarEventId', ?) WHERE id = ?");
linkEvent.run(heroEvent, hero);
linkEvent.run(scopeEvent, scope);
linkEvent.run(oneToOneEvent, oneToOne);

/** Eight weeks of a recurring sync, so the audit page has a series worth auditing. */
for (let w = 1; w <= 8; w++) {
  event(`demo-sync-past-${w}`, "Platform sync — Postgres cutover", -7 * w, "11:00", "11:45", {
    series_id: "feed:platform-sync",
    container_id: P.postgres,
    decision: w % 4 === 0 ? "not-going" : "going",
  });
  event(`demo-standup-past-${w}`, "Platform standup", -7 * w, "09:30", "09:45", { attendees: 6, series_id: "feed:standup", decision: "going" });
}
insert("meeting_series_containers", { series_id: "feed:platform-sync", container_id: P.postgres, assigned_at: iso(-30, "09:00") });

/* ---------------------------------------------------------------- goals */

const shipBilling = insert("goals", {
  title: "Billing runs itself by the end of the quarter",
  outcome: "A month closes without anyone opening a spreadsheet, and the invoice run is a button rather than an afternoon.",
  horizon: "quarter",
  target_date: day(57),
  status: "active",
  notes: "",
  sort_order: 0,
  created_at: iso(-45, "09:00"),
  updated_at: iso(-2, "09:00"),
});
const quietOncall = insert("goals", {
  title: "On-call stops waking people up",
  outcome: "Under four pages a week, none of them duplicates of each other, for four consecutive weeks.",
  horizon: "quarter",
  target_date: day(57),
  status: "active",
  notes: "",
  sort_order: 1,
  created_at: iso(-45, "09:05"),
  updated_at: iso(-9, "09:00"),
});
insert("goal_links", { goal_id: shipBilling, container_id: P.billing });
insert("goal_links", { goal_id: shipBilling, container_id: P.postgres });
insert("goal_links", { goal_id: quietOncall, container_id: P.oncall });

/* ---------------------------------------------------------------- calls made before the answer was known */

const prediction = (kind, claim, resolveBy, extra = {}) =>
  insert("predictions", {
    kind,
    claim,
    resolve_by: resolveBy,
    notes: "",
    created_at: iso(-14, "09:00"),
    updated_at: iso(-14, "09:00"),
    ...extra,
  });

prediction("estimate", "The overnight backfill of orders", day(-1), {
  container_id: P.postgres,
  unit: "hours",
  p50_low: 8,
  p50_high: 10,
  p90_low: 7,
  p90_high: 14,
  actual: 11,
  resolved_at: iso(0, "09:50"),
  notes: "Inside the 90% range, outside the 50%. The index build on order_items was the part I had not costed.",
});
prediction("risk", "We will need to roll back at least once during the cutover weekend", day(18), {
  container_id: P.postgres,
  probability: 0.2,
});
prediction("call", "The slow backfill will turn out to be the index build, not the network", day(-1), {
  container_id: P.postgres,
  outcome: 1,
  resolved_at: iso(0, "09:51"),
});
prediction("estimate", "Hiring a platform engineer, from first screen to signed offer", day(27), {
  container_id: P.hiring,
  unit: "weeks",
  p50_low: 5,
  p50_high: 7,
  p90_low: 4,
  p90_high: 12,
});

/* ---------------------------------------------------------------- the day as it actually went */

// The app seeds its own categories and rules on first boot, keyed on bundle ids -- so the demo
// uses those rather than inventing a second taxonomy the screenshots would then be the only
// place anyone sees.
const catId = (name) => db.prepare("SELECT id FROM activity_categories WHERE name = ?").get(name).id;
const CAT = {
  coding: catId("Coding"),
  meetings: catId("Meetings"),
  comms: catId("Communication"),
  browsing: catId("Browsing"),
  writing: catId("Writing"),
};

const session = (from, to, appId, appName, title, categoryId, extra = {}) =>
  insert("activity_sessions", {
    started_at: iso(0, from),
    ended_at: iso(0, to),
    closed: 1,
    app_id: appId,
    app_name: appName,
    title,
    category_id: categoryId,
    afk: 0,
    heartbeats: 20,
    manual: 0,
    ...extra,
  });

session("08:40", "09:02", "com.apple.mail", "Mail", "Inbox — 14 unread", CAT.comms);
session("09:02", "09:30", "com.apple.Terminal", "Terminal", "backfill — tail -f migrate.log", CAT.coding);
const eventId = (externalId) => db.prepare("SELECT id FROM calendar_events WHERE external_id = ?").get(externalId).id;
session("09:30", "09:46", "us.zoom.xos", "zoom.us", "Platform standup", CAT.meetings, { meeting_id: eventId("demo-standup-today") });
session("09:46", "10:28", "com.apple.Terminal", "Terminal", "psql — replica lag", CAT.coding);
session("10:28", "10:58", "com.microsoft.VSCode", "Code", "orders_backfill.sql — meridian/platform", CAT.coding);
session("10:58", "11:00", "com.tinyspeck.slackmacgap", "Slack", "#platform", CAT.comms);
session("11:00", "11:44", "us.zoom.xos", "zoom.us", "Platform sync — Postgres cutover", CAT.meetings, { meeting_id: eventId("demo-sync-today") });
session("11:44", "12:10", "com.google.Chrome", "Chrome", "Logical replication — PostgreSQL", CAT.browsing, {
  url: "https://www.postgresql.org/docs/current/logical-replication.html",
  domain: "postgresql.org",
});
session("12:10", "12:40", "com.tinyspeck.slackmacgap", "Slack", "#incidents", CAT.comms);
session("13:30", "14:35", "com.microsoft.VSCode", "Code", "runbook.md — meridian/platform", CAT.writing);
session("14:35", "15:00", "com.google.Chrome", "Chrome", "pull/482 — meridian/platform", CAT.coding, {
  url: "https://github.com/meridian/platform/pull/482",
  domain: "github.com",
});

/* ---------------------------------------------------------------- settings */

const setting = (key, value) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
// Nothing in a demo directory should ever reach for the microphone.
setting("meetings.autoRecord", "0");
setting("activity_paused", "0");
// Without this the planner shows its "the helper has no calendar access" setup card, which is
// true of a seeded directory and false of the install the screenshots are meant to describe.
setting("activity.helper.calendarsSeen", "2");
setting(
  "activity_helper_state",
  JSON.stringify({
    lastSeen: new Date().toISOString(),
    version: "0.5.3",
    permissions: { accessibility: true, calendar: true, automation: {} },
  }),
);

db.exec("COMMIT");

const counts = ["containers", "items", "tasks", "task_blocks", "calendar_events", "activity_sessions", "predictions", "goals", "people", "chunks"]
  .map((t) => `${t}=${db.prepare(`SELECT count(*) c FROM ${t}`).get().c}`)
  .join(" ");
console.log(`seeded ${dataDir}\n  ${counts}`);
db.close();
