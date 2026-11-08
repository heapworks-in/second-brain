import { z } from "zod";
import type { DB } from "@/db/client";
import type { JobHandler } from "@/jobs/worker";
import { jobPayload } from "@/jobs/payload";
import { getItem, parseMeta, updateItem } from "@/domain/items";
import { getChatProvider, summaryUnavailable, type ChatProvider } from "@/providers/chat";
import { ANSWER_TOKEN_RESERVE } from "@/providers/chat/llamacpp";
import { ContextOverflowError } from "@/providers/llama-cli-output";
import { chunkTranscript } from "@/domain/meetings/chunk";
import { mergeSummaries, type SummaryPart } from "@/domain/meetings/merge-summaries";

/**
 * Four more fields were tried here and taken back out: owner and deadline on each action, plus
 * risks and open_questions, to match the meeting template this app is modelled on.
 *
 * Measured on the same transcript, repeatedly, widening the schema made every field worse. The
 * model filled owner and deadline zero times out of two while still writing "By end of week, for
 * Priya" into `notes` -- it had the information and would not put it where it was asked. risks and
 * open_questions came back empty, and decisions dropped from one to zero: asking for seven things
 * cost the one it had been getting right.
 *
 * So the schema stays narrow, which is what the local 7B model can actually do. Owner and deadline
 * are better confirmed by a person when accepting an action as a task -- which is what the source
 * material asks for anyway ("repeat the ask, owner, deadline"): a confirmation step, not an
 * extraction problem.
 */
export const MeetingSummarySchema = z.object({
  summary: z.string().describe("One short paragraph covering what the meeting was about and where it got to."),
  decisions: z
    .array(z.string())
    .describe(
      "Each question the meeting closed, one line each: a choice made, an option rejected, a date or owner fixed, something approved, cancelled or deferred. Anything the summary says was settled belongs here too. Empty only when the meeting settled nothing.",
    ),
  proposed_actions: z
    .array(
      z.object({
        title: z.string().describe("The task, as an imperative line short enough for a to-do list."),
        notes: z.string().default("").describe("Who owns it and by when, if the meeting said. Empty otherwise."),
      }),
    )
    .describe("Work the meeting left somebody holding. Empty when it left none."),
});

export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;

const TOOL_NAME = "record_meeting_summary";

const SYSTEM = [
  "You summarise meeting transcripts for a personal knowledge base.",
  "Write in British English, in plain sentences, and stay with what was said: no advice, no filler, no invented names.",
  "The summary is one short paragraph.",
  // The model reliably folded settled questions into the paragraph and then returned decisions:
  // [] -- a transcript that chose Tuesday over Friday and cancelled a hire came back with three
  // actions and no decisions at all. Naming what counts, and requiring anything settled in the
  // paragraph to appear in the list too, is what stops the summary absorbing them.
  "A decision is any question the meeting closed: a choice made, an option rejected, a date or owner fixed, something approved, cancelled or deferred.",
  "List each decision as its own line. If the summary paragraph says the meeting settled something, that same thing must also appear in decisions.",
  "Return no decisions only when the meeting genuinely settled nothing -- a status update or a discussion that reached no conclusion.",
  "Proposed actions are the things somebody now has to do, phrased as a task title with a note naming who and by when if the meeting said so.",
  "A decision and the action it creates are both recorded: choosing to run the backfill on Tuesday is a decision, and booking the window is an action.",
  "Never guess who owns something, and never invent a date: if the meeting did not say, the note leaves it out.",
].join(" ");

interface PartsOutcome {
  summary: MeetingSummary;
  parts: MeetingSummary[];
  gaps?: string;
}

/**
 * A transcript too long for one pass: summarise each part, union the lists in code, and ask the
 * model for a single paragraph over the part paragraphs.
 *
 * A part that fails for any reason other than length does not sink the whole summary -- the rest
 * is still a true account of the rest, and `gaps` says which parts are missing so it is never
 * presented as complete. Returns null only when no part could be summarised at all.
 */
async function summarizeInParts(args: {
  provider: ChatProvider;
  title: string;
  transcript: string;
  notes: string;
  promptChars: number;
  overflow: ContextOverflowError;
  log: (message: string) => void;
}): Promise<PartsOutcome | null> {
  const { provider, title, transcript, notes, promptChars, overflow, log } = args;

  const budget = chunkBudgetChars(promptChars, overflow);
  const pieces = buildPieces(transcript, notes, budget);
  log(`[summarize_meeting] summarising in ${pieces.length} parts of up to ${budget} characters`);

  const parts: MeetingSummary[] = [];
  const failures: string[] = [];
  for (const [index, piece] of pieces.entries()) {
    try {
      parts.push(...(await summarizePiece(provider, title, piece, 0, log)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`part ${index + 1}: ${message}`);
      log(`[summarize_meeting] part ${index + 1} of ${pieces.length} failed: ${message}`);
    }
  }
  if (parts.length === 0) return null;

  // The narrative pass is the one step allowed to fail quietly: mergeSummaries falls back to the
  // parts' own paragraphs, which is longer to read but just as complete.
  let narrative: string | undefined;
  try {
    const written = await provider.structured({
      system: NARRATIVE_SYSTEM,
      user: [`Meeting: ${title}`, "", "Part summaries, in order:", ...parts.map((p, i) => `${i + 1}. ${p.summary}`)].join("\n"),
      schema: NarrativeSchema,
      name: "record_meeting_narrative",
      description: "Record one paragraph covering the whole meeting.",
    });
    narrative = written.summary;
  } catch (err) {
    log(`[summarize_meeting] the narrative pass failed (${err instanceof Error ? err.message : String(err)}); keeping the parts' own paragraphs`);
  }

  const merged = mergeSummaries(parts as SummaryPart[], narrative);
  const gaps =
    failures.length > 0
      ? `${failures.length} of ${pieces.length} parts of the transcript could not be summarised, so this does not cover all of it (${failures.join("; ")})`
      : undefined;

  return { summary: MeetingSummarySchema.parse(merged), parts, gaps };
}

export interface SummarizeMeetingDeps {
  db: DB;
  /**
   * Injected by tests and by anything that already holds a provider. Left out, the model is
   * resolved when the job runs, so one installed after boot takes effect without a restart;
   * passing null is a deliberate "there is none".
   */
  provider?: ChatProvider | null;
  log?: (message: string) => void;
}

interface MeetingMeta {
  summary?: MeetingSummary;
  summaryError?: string;
  /** Each part's own summary, kept when the transcript had to be split. Not shown anywhere: it is
   *  here so coverage can be checked against the transcript rather than taken on trust. */
  summaryParts?: MeetingSummary[];
  /** Set when a summary was produced but does not cover the whole transcript, naming what is
   *  missing. Distinct from `summaryError`, which means there is no summary at all. */
  summaryGaps?: string;
}

/** Just the paragraph, for the pass that writes one over the parts' own paragraphs. */
const NarrativeSchema = z.object({
  summary: z.string().describe("One short paragraph covering the whole meeting, drawn only from the part summaries given."),
});

const PART_SYSTEM = [
  SYSTEM,
  "You are given one part of a longer meeting transcript, in order.",
  "Summarise only what this part contains. Do not guess at what came before or after it, and do not try to conclude the whole meeting.",
].join(" ");

const NARRATIVE_SYSTEM = [
  "You are given the part-by-part summaries of one long meeting, in order.",
  "Write one short paragraph covering the meeting as a whole, in British English, in plain sentences.",
  "Use only what the parts say. Do not list decisions or actions -- those are already recorded separately.",
].join(" ");

/** How far the splitting will go before giving up. Each level divides the budget, so three is
 *  already a transcript an order of magnitude past the window. */
const MAX_SPLIT_DEPTH = 3;

/** Shrink applied on top of the calibrated ratio, covering the scaffolding the provider adds to
 *  every prompt (the system text and the closing instruction) and local variation in how densely
 *  a given passage tokenises. */
const BUDGET_SAFETY = 0.9;

/**
 * How many characters of transcript will fit, calibrated on the transcript that just overflowed
 * rather than on an assumed characters-per-token constant -- measured here, real speech runs 4.12
 * and repetitive text 5.0, so a constant is wrong by enough to matter.
 *
 * `promptChars` counts only the message this job built, while `promptTokens` covers the whole
 * prompt the provider sent, system text included. That makes the ratio an under-estimate, and so
 * the budget an under-estimate: it errs towards more, smaller parts, never towards a part the
 * model will refuse.
 */
function chunkBudgetChars(promptChars: number, overflow: ContextOverflowError): number {
  const charsPerToken = promptChars / overflow.promptTokens;
  const usableTokens = Math.max(1, overflow.contextTokens - ANSWER_TOKEN_RESERVE);
  return Math.max(500, Math.floor(usableTokens * charsPerToken * BUDGET_SAFETY));
}

interface Piece {
  /** How the part is introduced in the prompt. */
  heading: string;
  text: string;
}

/**
 * The transcript as parts that fit, with the notes carried along.
 *
 * The notes ride with the final part when there is room, rather than always getting a call of
 * their own: they are usually a line or two, and a part is minutes of model time. They are never
 * simply dropped into the narrative pass alone, though -- a note naming an owner or an action is
 * exactly the kind of thing that has to reach the structured pass to be recorded at all.
 */
function buildPieces(transcript: string, notes: string, budget: number): Piece[] {
  const chunks = chunkTranscript(transcript, { budget });
  const pieces: Piece[] = chunks.map((text, i) => ({ heading: `Transcript (part ${i + 1} of ${chunks.length}):`, text }));
  if (!notes) return pieces;

  const notesHeading = "Notes taken during the meeting:";
  const last = pieces[pieces.length - 1];
  if (last && last.text.length + notes.length + notesHeading.length + 2 <= budget) {
    last.text = `${last.text}\n\n${notesHeading}\n${notes}`;
    return pieces;
  }
  return [...pieces, { heading: notesHeading, text: notes }];
}

function pieceMessage(title: string, piece: Piece): string {
  return [`Meeting: ${title}`, "", piece.heading, piece.text].join("\n");
}

/**
 * One part's summary, splitting it again if the model refuses even this much. The recursion is
 * what makes the length genuinely unbounded: the first split is sized from the whole transcript's
 * ratio, and a passage that tokenises more densely than that average gets re-sized from its own.
 */
async function summarizePiece(
  provider: ChatProvider,
  title: string,
  piece: Piece,
  depth: number,
  log: (message: string) => void,
): Promise<MeetingSummary[]> {
  const user = pieceMessage(title, piece);
  try {
    const summary = await provider.structured({
      system: PART_SYSTEM,
      user,
      schema: MeetingSummarySchema,
      name: TOOL_NAME,
      description: "Record the summary, the decisions, and the actions this part of the meeting proposed.",
    });
    return [summary];
  } catch (err) {
    if (!(err instanceof ContextOverflowError)) throw err;
    if (depth >= MAX_SPLIT_DEPTH) throw err;

    const budget = chunkBudgetChars(user.length, err);
    const smaller = chunkTranscript(piece.text, { budget });
    // One piece that cannot be divided further would otherwise recurse on itself forever.
    if (smaller.length <= 1) throw err;

    log(`[summarize_meeting] a part still overflowed (${err.message}); splitting it into ${smaller.length}`);
    const out: MeetingSummary[] = [];
    for (const text of smaller) {
      out.push(...(await summarizePiece(provider, title, { heading: piece.heading, text }, depth + 1, log)));
    }
    return out;
  }
}

/**
 * The summary pass over a finished meeting: the final transcript plus whatever was typed into
 * the notes. Without a local model there is nothing to ask, and a meeting without a summary is
 * still a meeting -- but the item says so, rather than looking like a summary still on its way.
 */
export function createSummarizeMeetingHandler(deps: SummarizeMeetingDeps): JobHandler {
  const { db } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));

  return async (job) => {
    const { itemId } = jobPayload<{ itemId: number }>(job);
    const item = getItem(db, itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    const fail = (message: string) => {
      // A summary is a nicety: a failure is recorded on the item and the job is done, rather
      // than retried three times and left red in the queue.
      const current = getItem(db, itemId);
      if (current) updateItem(db, itemId, { meta: { ...parseMeta<MeetingMeta>(current), summaryError: message } });
      log(`[summarize_meeting] item ${itemId} could not be summarised: ${message}`);
    };

    const provider = deps.provider !== undefined ? deps.provider : await getChatProvider();
    if (!provider) {
      // This used to return silently with one log line, which is how a Mac missing llama-cli
      // came to show "No summary yet" on every meeting for ever: the job completed, nothing was
      // written to the item, and the only record was a line in a log nobody reads. The reason
      // goes on the item now, where the page already renders it and the person can act on it.
      fail((await summaryUnavailable()) ?? "the summary model could not be resolved");
      return;
    }

    const transcript = item.extractedText.trim();
    const notes = item.body.trim();
    if (!transcript && !notes) {
      log(`[summarize_meeting] item ${itemId} has neither a transcript nor notes; nothing to summarise`);
      return;
    }

    const user = [
      `Meeting: ${item.title}`,
      "",
      transcript ? `Transcript:\n${transcript}` : "Transcript: none was recorded.",
      "",
      notes ? `Notes taken during the meeting:\n${notes}` : "Notes: none were taken.",
    ].join("\n");

    let summary: MeetingSummary;
    let parts: MeetingSummary[] | undefined;
    let gaps: string | undefined;
    try {
      summary = await provider.structured({
        system: SYSTEM,
        user,
        schema: MeetingSummarySchema,
        name: TOOL_NAME,
        description: "Record the summary, the decisions, and the actions the meeting proposed.",
      });
    } catch (err) {
      // One pass is tried first on purpose rather than measuring the transcript up front: the
      // refusal costs about a second, arrives before any inference, and reports the exact token
      // counts the split is then sized from. A short meeting pays nothing for this.
      if (!(err instanceof ContextOverflowError)) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      log(`[summarize_meeting] item ${itemId}: ${err.message}; summarising in parts`);
      const outcome = await summarizeInParts({ provider, title: item.title, transcript, notes, promptChars: user.length, overflow: err, log });
      if (!outcome) {
        fail(`the transcript is too long for one pass (${err.message}) and no part of it could be summarised`);
        return;
      }
      summary = outcome.summary;
      parts = outcome.parts;
      gaps = outcome.gaps;
    }

    // Re-read: the person may have been typing notes while the model was thinking.
    const current = getItem(db, itemId);
    if (!current) throw new Error(`Item ${itemId} not found`);
    const next: MeetingMeta = { ...parseMeta<MeetingMeta>(current), summary };
    delete next.summaryError;
    delete next.summaryParts;
    delete next.summaryGaps;
    if (parts) next.summaryParts = parts;
    if (gaps) next.summaryGaps = gaps;
    updateItem(db, itemId, { meta: next as Record<string, unknown> });
  };
}
