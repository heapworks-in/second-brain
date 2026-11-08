import type { ItemStatus, ItemType, ContainerKind, ContainerStatus, ResourceCategory, GoalHorizon, GoalStatus, FocusMode, FocusOutcome, ReviewStep, MeetingDecision, PredictionKind, PredictionUnit, ProposalKind } from "@/db/enums";
import type { CheckResult } from "@/db/safety";
import type { Distillation } from "@/domain/distill";

export interface ContainerRefDTO {
  id: number;
  name: string;
  slug: string;
  kind: ContainerKind;
}

export interface PersonRefDTO {
  id: number;
  name: string;
  slug: string;
}

export interface ItemDTO {
  id: number;
  type: ItemType;
  title: string;
  body: string;
  status: ItemStatus;
  error: string | null;
  sourceUrl: string | null;
  filePath: string | null;
  mimeType: string | null;
  extractedText: string;
  meta: Record<string, unknown>;
  tags: string[];
  journalDate: string | null;
  reviewWeek: string | null;
  containerId: number | null;
  container: ContainerRefDTO | null;
  archivedAt: string | null;
  pinned: boolean;
  people: PersonRefDTO[];
  createdAt: string;
  updatedAt: string;
  /** The item's own pending offer, or its kept/dismissed history -- undefined when the sweep
   * hasn't offered one yet (never re-offered once decided; `@/domain/distill`). */
  distillation?: Distillation;
}

export interface PinnedLinkDTO {
  id: number;
  title: string;
  url: string;
  domain: string;
}

export interface SearchResultDTO {
  item: ItemDTO;
  snippet: string;
  score: number;
  chunkId: number;
}

export interface ProgressDTO {
  open: number;
  done: number;
  total: number;
  percent: number;
  nextTask: { id: number; title: string; dueDate: string | null } | null;
}

/** One session of a task on the timeline. */
export interface BlockDTO {
  id: number;
  taskId: number;
  startsAt: string;
  minutes: number;
  /** Minutes actually run against this session — what the box cost, against the `minutes` it was
   * promised. 0 until a focus run has been started from it and booked something; an abandoned run
   * books nothing. Only the day's own payload fills this in; a session written by `POST
   * /api/blocks` answers 0 because nothing can have run against it yet. */
  spentMinutes: number;
}

export interface TaskDTO {
  id: number;
  title: string;
  notes: string;
  status: "open" | "done" | "dropped";
  priority: "low" | "normal" | "high";
  dueDate: string | null;
  containerId: number | null;
  sourceItemId: number | null;
  estimateMinutes: number | null;
  /** How long each placed session should be; null leaves the sizing to the scheduler. */
  sessionMinutes: number | null;
  /** The task's sessions, ordered by start, across every day it holds one. */
  blocks: BlockDTO[];
  /** The active goals the task's container serves; empty with no container or none active. */
  goals: GoalRefDTO[];
  /** Minutes actually run against the task, summed from every run that booked anything — 0
   * with no run landed yet, never a run's own zero (an abandoned run books nothing at all). */
  spentMinutes: number;
  /** What finished tasks like this one actually took — the median booked minutes of `done`
   * tasks in the same container whose title shares a meaningful word with this one. Null below
   * three such matches, or with no container: an honest hint needs real data behind it
   * (`src/domain/focus/index.ts`'s `likeThisMinutesByTask`), and `EstimateHint` only ever
   * offers it on an open task with no estimate of its own. */
  likeThisMinutes: number | null;
  completedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** A task as it sits on one day's plan: `sortOrder` is the plan's order, not the task's order
 * inside its container, and `planId` is the plan entry itself. */
export interface PlanTaskDTO extends TaskDTO {
  planId: number;
}

export interface PlanDTO {
  date: string;
  tasks: PlanTaskDTO[];
  unfinishedYesterday: TaskDTO[];
}

export interface ContainerDTO {
  id: number;
  kind: ContainerKind;
  name: string;
  slug: string;
  description: string;
  status: ContainerStatus;
  goal: string;
  deadline: string | null;
  standard: string;
  nextSteps: string;
  category: ResourceCategory | null;
  sortOrder: number;
  archivedAt: string | null;
  itemCount: number;
  totalItemCount: number;
  progress: ProgressDTO;
  pinnedLinks: PinnedLinkDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface SourceGroupDTO {
  /** Only what a home heading needs: a group carries no counts of its own. */
  container: ContainerRefDTO;
  tasks: TaskDTO[];
}

/** Every open task, by where it lives, for the plan picker. */
export interface PlannerSourcesDTO {
  inbox: TaskDTO[];
  due: { overdue: TaskDTO[]; today: TaskDTO[] };
  projects: SourceGroupDTO[];
  areas: SourceGroupDTO[];
}

export interface CapacityDTO {
  freeMinutes: number;
  plannedMinutes: number;
  unestimated: number;
  workHours: string;
  /** ISO weekday numbers (Monday 1 through Sunday 7) the plan is measured against — the same
   * list `isWorkingDay` gates the week on (`src/lib/work-hours.ts`), read back here so the
   * working-hours chip has a working-days one to sit beside rather than a write path with no
   * control (honest-forecast review F4). */
  workingDays: number[];
  blockedMinutes: number;
  unplacedMinutes: number;
  /** The person's own actual-over-estimate multiplier, from their last `DRIFT_WINDOW` finished
   * tasks — null below `DRIFT_MIN_PAIRS`, honestly, rather than a figure built from too little
   * to mean anything (`src/lib/drift.ts`). */
  drift: number | null;
  /** `plannedMinutes` scaled by `drift`; null exactly when `drift` is. */
  forecastMinutes: number | null;
  /** Free minutes left in the working day, as of `now`: the remainder of today once part of it
   * has passed, 0 once today's window is over, and — for a date other than today — the whole
   * window, the same figure `freeMinutes` reports with no `now` at all. Only genuinely reads as
   * "time left" when the day in question is today. */
  leftTodayMinutes: number;
}

export interface PersonDTO {
  id: number;
  name: string;
  slug: string;
  profile: string;
  organization: string;
  team: string;
  title: string;
  itemCount: number;
  /** The most recent item linked to them, of any kind -- `null` on the single-person routes that
   * never compute it, and for someone nothing has ever been linked to. */
  lastContact: string | null;
  /** How many of their linked items are meetings -- 0 where it was never computed. */
  meetingCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityCategoryDTO { id: number; name: string; color: string; sortOrder: number }
export interface ActivityRuleDTO { id: number; matchKind: "app" | "domain" | "title_contains"; pattern: string; categoryId: number; sortOrder: number }
export interface ActivityExclusionDTO { id: number; kind: "app" | "domain"; pattern: string }
export interface HelperStateDTO {
  lastSeen: string | null;
  version: string | null;
  permissions: { accessibility: boolean; calendar: boolean; automation: Record<string, boolean> } | null;
  calendarsSeen: number | null;
}
export interface ActivitySessionDTO {
  id: number; startedAt: string; endedAt: string; appId: string | null; appName: string | null; title: string | null;
  domain: string | null; categoryId: number | null; afk: boolean; meetingId: number | null;
}
export interface ActivityMeetingDTO {
  id: number; title: string; startsAt: string; endsAt: string; attendees: number; hasCallLink: boolean; interview: boolean;
  scheduledMs: number; actualMs: number; itemId: number | null;
  organizer: string; attendeeNames: string[]; location: string; joinUrl: string | null; allDay: boolean;
  status: "accepted" | "tentative" | "declined" | "none"; calendarTitle: string; noRecord: boolean;
  /** Shared by every occurrence of a recurring series, null for a one-off meeting — what a
   * "just this one, or every time" choice on the row needs to know before it can even ask. */
  seriesId: string | null;
  /** The *effective* decision (`effectiveDecisionAsOf`, `@/domain/meetings/decision`), already
   * resolved server-side: this occurrence's own override, else its series' decision *if that
   * decision was made before this occurrence started*, else what `status` implies. Never
   * `"maybe"` unless a person chose it — see `effectiveDecision`. The `AsOf` resolution is what
   * keeps a decision made today from re-rendering an hour already sat through as declined; for
   * anything from now onward it answers exactly as plain `effectiveDecision` would. */
  decision: MeetingDecision;
  /** This occurrence's own note, alongside its own `decision` — not resolved through the series. */
  decisionNote: string;
  /** The series' own standing decision (`meetingSeriesDecisions`), independent of this occurrence's
   * own override — null when this is a one-off meeting or nobody has ever decided one for its
   * series. This is what a row needs to know an active series decision exists at all *to reverse*:
   * `decision` above already folds a series decision into its answer, so it alone cannot tell "no
   * decision was ever made" apart from "an occurrence override happens to agree with the default".
   * Resolved and batched the same way `decision` is, from the same `seriesDecisionDetailsFor`
   * call — never a second, per-row query. Unlike `decision` this is *not* time-scoped: it answers
   * "does a standing series decision exist", which is true regardless of when it was made. */
  seriesDecision: MeetingDecision | null;
  /** The project or area this meeting counts against, already resolved server-side: this
   * occurrence's own assignment, else its series'. Null means nothing claims it yet. Unlike
   * `decision` this is deliberately *not* time-scoped -- an assignment classifies what a meeting
   * has always been, so it applies to occurrences that happened before it was made. */
  containerId: number | null;
  /** True when the resolved `containerId` comes from the series rather than this occurrence --
   * what a row needs to say "every occurrence" versus "just this one" without a second query. */
  containerFromSeries: boolean;
}

export interface ActivityDayDTO {
  day: string;
  activeMs: number;
  sessions: ActivitySessionDTO[];
  byCategory: { categoryId: number | null; ms: number }[];
  byApp: { appId: string | null; appName: string | null; ms: number }[];
  bySite: { key: string; label: string; ms: number }[];
  meetings: ActivityMeetingDTO[];
  categories: ActivityCategoryDTO[];
  helper: HelperStateDTO;
  paused: boolean;
  retentionDays: number;
}
export interface ActivityWeekDTO {
  start: string;
  days: { day: string; activeMs: number; byCategory: { categoryId: number | null; ms: number }[] }[];
  categories: ActivityCategoryDTO[];
}

/** The recording session as the chip and the Record buttons read it. */
export interface RecorderStatusDTO {
  state: "idle" | "recording" | "stopping" | "error";
  itemId?: number;
  title?: string;
  startedAt?: string;
  systemAudio?: boolean;
  error?: string;
  autoStarted?: boolean;
  keep?: boolean;
  /** Tool keys `checkTools` could not find; a non-empty list puts Record out of reach. */
  missing: string[];
}

/** A published calendar link and the state of its last sync. */
export interface CalendarFeedDTO {
  feedUrl: string;
  syncedAt: string | null;
  error: string | null;
  count: number;
  /** Present on the answers to a save or a "Sync now". */
  sync?: { state: "off" } | { state: "ok"; count: number; syncedAt: string } | { state: "error"; error: string };
}

/** The two auto-record switches in the Meetings header, plus design §9's audio retention window:
 * `null` keeps every recording forever, `0`-`365` the days past a recording's end. Optional here
 * only so existing object literals in tests that predate it still typecheck -- the route always
 * includes it. */
export interface MeetingSettingsDTO {
  autoRecord: boolean;
  autoRecordNeedsCallLink: boolean;
  audioRetentionDays?: number | null;
}

/** Design §9's audio footprint, folded into the same status line: how many recordings are
 * held, how much space they take, and when the next one is due for release. */
export interface AudioFootprintDTO {
  recordings: number;
  bytes: number;
  nextReleaseAt: string | null;
}

/** Design §7's one line: what `safetyStatus` (`src/lib/safety-status.ts`) knows about the last
 * backup and the last integrity check, read by the Activity page's `SafetyLine`. */
export interface SafetyStatusDTO {
  lastBackupAt: string | null;
  verified: boolean;
  recoveryPoints: number;
  oldest: string | null;
  integrity: CheckResult;
  audio: AudioFootprintDTO;
}

/** What the Planner knows about the helper's calendar access, for the setup card. */
export interface PlannerCalendarDTO {
  /** How many calendars the helper can see; null until it has reported at all. */
  calendarsSeen: number | null;
  permission: boolean;
}

export interface PlannerDayDTO {
  date: string;
  plan: PlanTaskDTO[];
  unfinishedYesterday: TaskDTO[];
  meetings: MeetingListDTO[];
  calendar: PlannerCalendarDTO;
  sources: PlannerSourcesDTO;
  capacity: CapacityDTO;
}

export interface PlannerWeekDayDTO {
  date: string;
  /** Whether this day is one of the saved working days; a non-working day's capacity is
   * reported as zero across the board rather than the whole window it would otherwise show. */
  working: boolean;
  meetings: ActivityMeetingDTO[];
  due: TaskDTO[];
  capacity: {
    freeMinutes: number;
    plannedMinutes: number;
    blockedMinutes: number;
    /** `plannedMinutes` scaled by the week's own `drift` (`PlannerWeekDTO.drift`, one figure
     * for the whole week, not measured per day); null exactly when that drift is. */
    forecastMinutes: number | null;
    /** The same figure `CapacityDTO.leftTodayMinutes` reports, for this day: 0 once the day is
     * over, the remainder of today once part of it has passed, and the whole window for a day
     * still ahead. Only genuinely reads as "time left" when this day is today. */
    leftTodayMinutes: number;
  };
}

export interface PlannerWeekDTO {
  start: string;
  /** The person's own actual-over-estimate multiplier, read once for the whole week — never
   * once per day — and null below `DRIFT_MIN_PAIRS`, the same honesty rule `CapacityDTO.drift`
   * follows. Each day's `capacity.forecastMinutes` is this same figure applied to that day's
   * own planned minutes. */
  drift: number | null;
  days: PlannerWeekDayDTO[];
}

/** What the linked meeting item already holds, so a row can badge it without loading the item. */
export interface MeetingItemDTO {
  id: number;
  hasNotes: boolean;
  hasTranscript: boolean;
  hasSummary: boolean;
  /** Null when the item has not been filed to a project or area yet — what the suggestion
   * offer, and the project-filtered meetings view, both key off. */
  containerId: number | null;
}

export type MeetingListDTO = ActivityMeetingDTO & {
  item?: MeetingItemDTO;
  /** The dull suggestion for where this meeting probably belongs (`suggestContainer`,
   * `@/domain/containers/suggest`), present only when the item exists and has no container yet.
   * An offer, never an assignment — accepting it writes through the existing item `PATCH`;
   * nothing here writes on its own. */
  suggestedContainer?: ContainerRefDTO | null;
};

export interface PlannerMeetingsDTO {
  from: string;
  to: string;
  meetings: MeetingListDTO[];
  calendar: PlannerCalendarDTO;
  /** The `?container=` filter, already parsed and validated once by the page — resolved here
   * rather than re-parsed from the raw query string client-side, so the two never disagree on
   * what counts as a valid id (review N1). Null when no filter is in effect. */
  containerId: number | null;
}

/** A meeting filed to a project or area, for that container's own Meetings section — the same
 * badges `MeetingListDTO.item` carries, alongside the meeting's date, without the rest of the
 * Planner's own meeting shape (decisions, join links) that section has no use for. */
export interface ContainerMeetingDTO {
  title: string;
  /** Null for a meeting item with no calendar event behind it (an ad hoc recording). */
  startsAt: string | null;
  /** Null for a meeting attributed to this container that was never opened or recorded -- a
   *  series assigned to a project covers occurrences nobody took notes on, and they are still
   *  that project's meetings. Nothing to link to, so the row is not a link. */
  item: MeetingItemDTO | null;
  /** Stable row key when there is no item: the calendar event it came from. */
  eventId: number | null;
}

/** One timed thing on the day: the meeting or session Home shows as now, or as what comes next. */
export interface HomeItemDTO {
  kind: "meeting" | "session";
  title: string;
  /** A meeting's own instant (UTC), a session's local wall clock — each as its source records it. */
  startsAt: string;
  endsAt: string;
  meetingId?: number;
  joinUrl?: string;
  taskId?: number;
  blockId?: number;
}

/** An active project as Home's compact card reads it. */
export interface ProjectCardDTO {
  id: number;
  name: string;
  slug: string;
  open: number;
  done: number;
  nextTask: { id: number; title: string } | null;
  deadline: string | null;
  updatedAt: string;
}

/** One of the last items touched; `meeting` is set only on a meeting item, for its chip. */
export interface RecentItemDTO {
  id: number;
  type: ItemType;
  title: string;
  updatedAt: string;
  status: ItemStatus;
  meeting?: { hasTranscript: boolean; hasSummary: boolean };
}

/** Where the day stands, in one payload: the Planner's day plus what Home adds around it. */
export interface HomeDTO {
  date: string;
  today: string;
  /** The instant the payload was built, so "2 h ago" reads the same on the server and on the
   * first client render rather than drifting between them. */
  generatedAt: string;
  day: PlannerDayDTO;
  counts: { planned: number; meetings: number; inbox: number; desk: number };
  now: HomeItemDTO | null;
  /** Up to two, in start order, never the one `now` holds. */
  next: HomeItemDTO[];
  projects: ProjectCardDTO[];
  recent: RecentItemDTO[];
  /** Null until the helper has reported at all, which is what hides the section. */
  activity: { activeMs: number; top: { label: string; ms: number }[] } | null;
  /** What today has cost so far: booked minutes and run count, and the run still going, if
   * one is — the same live run a focus-aware surface reads through `useFocus()`, carried here
   * too so the page's first paint already knows it rather than waiting on that store's own
   * fetch. */
  focus: { minutes: number; running: FocusRunDTO | null };
  /** Design §5.3: the one quiet nudge toward `/review`. `due` is true only from Friday on, and
   * only while the current week has opened no review yet — it never turns true again once one
   * exists, and it never turns red or insistent as Sunday nears. The link this badges is a
   * static `/review`, not `/review?week=…`, so only `due` is read here — the week and the save
   * time belong to `/review`'s own payload, not to Home's. */
  review: { due: boolean };
  /** This week's meeting load, the audit page's own `weeklyMeetingShare` reused directly so the
   * two figures can never disagree about the same week. */
  meetingShare: { minutes: number; workingMinutes: number };
  /** Active goals with nothing closed against them lately (`GoalMeasureDTO.stalled`, the same
   * flag the Goals page and Weekly Review's own Goals step already compute) — named here so
   * the one thing worth a click is a click away, not a trip through /goals to find which. */
  stalledGoals: { id: number; title: string }[];
  /** Calls whose resolve-by date has passed and which nobody has scored. A count rather than the
   *  rows, unlike `stalledGoals`: `/log` already puts the overdue ones at the top, so naming them
   *  twice would only make the quiet line loud. */
  duePredictions: number;
}

export interface GoalMeasureDTO {
  open: number;
  done: number;
  total: number;
  percent: number;
  movement: number;
  lastClosedAt: string | null;
  stalled: boolean;
}

/** The goal a task's project serves, as a row chip shows it. */
export interface GoalRefDTO {
  id: number;
  title: string;
}

export interface GoalDTO {
  id: number;
  title: string;
  outcome: string;
  horizon: GoalHorizon;
  targetDate: string;
  status: GoalStatus;
  notes: string;
  sortOrder: number;
  closedAt: string | null;
  measure: GoalMeasureDTO;
  containers: ContainerRefDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface GoalDetailDTO extends GoalDTO {
  /** Each linked container with its own progress, so the goal page shows where the work is. */
  links: { container: ContainerRefDTO; progress: ProgressDTO }[];
  recentCloses: { id: number; title: string; completedAt: string; containerName: string }[];
}

/** One stretch of focused work on a task, live or finished. `endedAt`, `actualMinutes` and
 * `outcome` are null while the run is still going. */
export interface FocusRunDTO {
  id: number;
  /** Null for a pomodoro started on nothing in particular. */
  taskId: number | null;
  taskTitle: string;
  blockId: number | null;
  startedAt: string;
  endedAt: string | null;
  plannedMinutes: number;
  actualMinutes: number | null;
  outcome: FocusOutcome | null;
}

/** The break between pomodoros, as the server reports it. `endsAt` null means none is running. */
export interface FocusBreakDTO {
  endsAt: string | null;
  remainingMs: number;
  minutes: number;
}

export interface FocusSettingsDTO {
  /** Which rhythm the pane offers: a pomodoro cycle with breaks, or a box with a decision at the
   * end. Both end up in the same `focus_runs` row. */
  mode: FocusMode;
  defaultMinutes: number;
  shortBreak: number;
  longBreak: number;
  longBreakEvery: number;
}

export interface FocusSummaryDTO {
  minutes: number;
  runs: number;
  byTask: { taskId: number; title: string; minutes: number; runs: number }[];
}

/** What a review has answered so far, one entry per step; `goals` is a note per goal id. */
export interface ReviewAnswersDTO {
  clear?: string;
  back?: string;
  goals?: Record<string, string>;
  ahead?: string;
}

/**
 * The week's review, assembled: what the week itself looked like — done, dropped, still open,
 * booked focus time, the projects that moved — and what is coming in the week after, read from
 * the same domains Home and the Planner already read them from, so the two screens can never
 * disagree about the same week.
 */
export interface ReviewDTO {
  /** The Monday the review is for. */
  week: string;
  label: string;
  days: string[];
  /** The day this payload was assembled on — for date math that genuinely means "now",
   * distinct from `asOf` below. */
  today: string;
  /** The day `goals[].measure` was actually measured as of: today for the current week, the
   * week's own last day for a closed one (design §5.1's "movement for the week" rule). Pass
   * this to `GoalRow`, never `today` — a past week's `stalled`/`movement` were computed against
   * its own end, not against whatever day the review happens to be read on. */
  asOf: string;
  /** Whether the week being reviewed is the one the app is being used in. */
  current: boolean;
  /** Where to resume: the first step with no answer yet, or the last step once every one does. */
  step: ReviewStep;
  answers: ReviewAnswersDTO;
  clear: {
    inbox: number;
    /** Still open on any day of the week, each counted once even if planned on several. */
    leftover: PlanTaskDTO[];
  };
  back: {
    /** Completed inside the week, by `completedAt`. */
    done: number;
    /** Dropped inside the week, by `droppedAt` — its own column, so editing a dropped task
     * later can never move it into a different week's count the way `updatedAt` would. */
    dropped: number;
    /** Planned in the week and still open — the same set `clear.leftover` lists, as a count. */
    slipped: number;
    focusMinutes: number;
    focusRuns: number;
    /** Meetings not declined and not all-day, on the calendar day they start — the same rule
     * and the same day-column selection `homePayload` counts by. A meeting that crosses local
     * midnight is attributed to the day it starts, once, here as there. */
    meetings: number;
    projects: { container: ContainerRefDTO; closed: number; percent: number }[];
    /** Calls logged in the week and calls scored in it. The reps, not the figures: the scores
     *  are over the whole log and would say nothing about one week. Zero on a review saved
     *  before the log existed, which is the truth — nothing was recorded. */
    predictions: { logged: number; resolved: number };
    /** True when these figures are the snapshot frozen in the item's meta at save time rather
     * than a live re-query — a past week whose review has one. A live re-query of `slipped`
     * (still-open tasks) drifts as soon as those tasks are closed, which would otherwise show
     * "Still open: 0" beside prose written about four open tasks. Design §5.2's snapshot exists
     * precisely so a review read back long after the fact still says what the week looked like
     * when it was written. */
    frozen: boolean;
  };
  /** Active goals, each with its movement measured as of the week's own last day — or as of
   * today when the week under review is the current one, since a week still in progress cannot
   * yet have movement from days it hasn't reached. */
  goals: GoalDTO[];
  ahead: {
    /** Next Monday. */
    week: string;
    due: TaskDTO[];
    deadlines: { container: ContainerRefDTO; deadline: string }[];
    meetings: ActivityMeetingDTO[];
  };
  /** When a step was last saved; null until the first one is — an opened-but-untouched review
   * has nothing to call "saved" yet. */
  savedAt: string | null;
}

/**
 * One logged call. The numbers each kind does not use are null: an `estimate` carries the four
 * range bounds, a unit and later an actual; a `risk` carries a probability and later an outcome;
 * a `call` carries only an outcome. `resolvedAt` is the single answer to "has this been scored",
 * whichever kind it is.
 */
export interface PredictionDTO {
  id: number;
  kind: PredictionKind;
  claim: string;
  containerId: number | null;
  taskId: number | null;
  itemId: number | null;
  unit: PredictionUnit | null;
  p50Low: number | null;
  p50High: number | null;
  p90Low: number | null;
  p90High: number | null;
  actual: number | null;
  probability: number | null;
  /** 1 or 0 once resolved, null while open. */
  outcome: number | null;
  resolveBy: string;
  resolvedAt: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** The three figures the log scores itself by. A null score means nothing has resolved yet. */
export interface PredictionScoresDTO {
  estimate: { logged: number; resolved: number; inRange: number; percent: number | null };
  risk: { logged: number; resolved: number; score: number | null };
  call: { logged: number; resolved: number; hit: number; percent: number | null };
}

export interface PredictionsDTO {
  predictions: PredictionDTO[];
  /** Always over the whole log, not the filtered view — a figure that moved when you clicked a
   *  filter would read as progress. */
  scores: PredictionScoresDTO;
  /** Unresolved and past their date, oldest first. The log's own nag, repeated from Home. */
  due: PredictionDTO[];
  today: string;
}

/** One card on the desk. `payload` stays on the server: the page never needs it, and a card is
 * answered by its id. */
export interface ProposalDTO {
  id: number;
  kind: ProposalKind;
  source: string;
  title: string;
  detail: string;
  rank: number;
  createdAt: string;
  /** How often this kind has been refused lately, 0..1 — what the card's own "why am I seeing
   * this?" line reads from, so the ranking is legible rather than mysterious. */
  dismissRate: number;
}

export interface DeskDTO {
  proposals: ProposalDTO[];
  /** Open proposals in total, which can exceed what `proposals` carries: the cap is the feature. */
  open: number;
  /** Decided today, for the finish line — the count is the reason to come back tomorrow. */
  decidedToday: number;
}
