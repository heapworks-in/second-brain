export const ITEM_TYPES = ["note", "link", "file", "meeting", "journal", "review"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const JOB_TYPES = [
  "fetch_link",
  "extract_pdf",
  "ocr_image",
  "transcribe_final",
  "summarize_meeting",
  "distill_note",
  "embed",
  "weekly_reflect",
  "backup",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const CONTAINER_KINDS = ["project", "area", "resource"] as const;
export type ContainerKind = (typeof CONTAINER_KINDS)[number];

export const CONTAINER_STATUSES = ["active", "archived"] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];

export const RESOURCE_CATEGORIES = ["articles", "tools", "reference", "research", "inspiration", "videos", "other"] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const TASK_STATUSES = ["open", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const MEETING_STATUSES = ["accepted", "tentative", "declined", "none"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const CALENDAR_SOURCES = ["eventkit", "feed"] as const;
export type CalendarSource = (typeof CALENDAR_SOURCES)[number];

/** The local, person-made call on a meeting — never the calendar's own RSVP, and never inferred
 * from it: `maybe` in particular carries its own capacity arithmetic (half the meeting's clipped
 * duration) that only means something once a person has actually chosen it. */
export const MEETING_DECISIONS = ["going", "not-going", "maybe"] as const;
export type MeetingDecision = (typeof MEETING_DECISIONS)[number];

export const GOAL_HORIZONS = ["quarter", "year"] as const;
export type GoalHorizon = (typeof GOAL_HORIZONS)[number];

export const GOAL_STATUSES = ["active", "hit", "missed", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const FOCUS_OUTCOMES = ["completed", "stopped", "abandoned"] as const;
export type FocusOutcome = (typeof FOCUS_OUTCOMES)[number];

/** The four questions a review walks through, in the order it walks them. Kept beside the other
 * enums, not in `@/domain/review`, so `src/lib/dto.ts` — read by client components — can name the
 * type without a domain edge; `@/db/enums` is already the one module it imports from. */
export const REVIEW_STEPS = ["clear", "back", "goals", "ahead"] as const;
export type ReviewStep = (typeof REVIEW_STEPS)[number];

/** The one name for each step — the on-screen step nav and announcer heading (`StepNav`) and the
 * `##` heading `renderReviewBody` writes into the item's Markdown both read this, so renaming a
 * step here renames it everywhere at once rather than only where whoever renamed it remembered
 * to look. Kept beside `REVIEW_STEPS` for the same reason that constant is kept here rather than
 * in `@/domain/review`: a client component needs the words without a domain edge. */
export const REVIEW_STEP_LABELS: Record<ReviewStep, string> = {
  clear: "Clear the decks",
  back: "Look back",
  goals: "Goals",
  ahead: "Look ahead",
};

/**
 * The three shapes a call can take, all of them "say it before you know".
 *
 * `estimate` carries two ranges and an actual: how long something will take, scored by whether
 * the actual landed inside the 90% range. `risk` carries a probability and a yes/no outcome,
 * scored by Brier. `call` carries neither number — it is a bare claim scored right or wrong,
 * which is what a root-cause guess before reading the postmortem is.
 */
export const PREDICTION_KINDS = ["estimate", "risk", "call"] as const;
export type PredictionKind = (typeof PREDICTION_KINDS)[number];

/** What an estimate's numbers count. Calibration is unit-blind, so this is only for display. */
export const PREDICTION_UNITS = ["hours", "days", "weeks"] as const;
export type PredictionUnit = (typeof PREDICTION_UNITS)[number];

/**
 * The two rhythms a focus run can be kept to. A pomodoro is a fixed length with a break after it
 * and a cycle behind it; a timebox is a length chosen for the work, with a hard stop and a
 * decision at the end rather than a break. The run itself is the same row either way — the mode
 * only decides what is offered before it starts and asked when it ends.
 */
export const FOCUS_MODES = ["pomodoro", "timebox"] as const;
export type FocusMode = (typeof FOCUS_MODES)[number];
