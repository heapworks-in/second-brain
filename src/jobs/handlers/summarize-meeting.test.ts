import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { createItem, getItem, parseMeta, updateItem } from "@/domain/items";
import { enqueueJob } from "@/jobs/queue";
import type { Job } from "@/db/schema";
import type { ChatProvider } from "@/providers/chat";
import { ContextOverflowError } from "@/providers/llama-cli-output";
import { createSummarizeMeetingHandler, MeetingSummarySchema } from "./summarize-meeting";

const SUMMARY = {
  summary: "The team agreed to ship the recorder on Friday.",
  decisions: ["Ship on Friday", "Drop the second microphone"],
  proposed_actions: [
    { title: "Write the release note", notes: "Ada offered" },
    { title: "Check the model download", notes: "" },
  ],
};

interface MeetingMeta {
  summary?: typeof SUMMARY;
  summaryError?: string;
  recording?: { state: string };
}

describe("summarize_meeting handler", () => {
  let t: TestDb;

  beforeEach(() => {
    t = makeTestDb();
    // The default provider resolves from the environment; no test may reach the real API.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    t.cleanup();
  });

  function meeting(over: { extractedText?: string; body?: string } = {}) {
    const item = createItem(t.db, {
      type: "meeting",
      title: "Product sync",
      body: over.body ?? "## Notes\n\nAda wants the recorder shipped.",
      status: "ready",
      meta: { recording: { state: "done" } },
    });
    return updateItem(t.db, item.id, { extractedText: over.extractedText ?? "We agreed to ship on Friday." });
  }

  function job(itemId: number): Job {
    return enqueueJob(t.db, "summarize_meeting", { itemId }, itemId);
  }

  it("writes meta.summary from the provider's structured answer", async () => {
    const item = meeting();
    const calls: { system: string; user: string; name: string }[] = [];
    const provider: ChatProvider = {
      structured: async (req) => {
        calls.push({ system: req.system, user: req.user, name: req.name });
        return MeetingSummarySchema.parse(SUMMARY) as never;
      },
    };
    const handler = createSummarizeMeetingHandler({ db: t.db, provider });

    await handler(job(item.id));

    const meta = parseMeta<MeetingMeta>(getItem(t.db, item.id)!);
    expect(meta.summary).toEqual(MeetingSummarySchema.parse(SUMMARY));
    expect(meta.summaryError).toBeUndefined();
    // The recorder's own meta survives the merge.
    expect(meta.recording?.state).toBe("done");
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain("We agreed to ship on Friday.");
    expect(calls[0].user).toContain("Ada wants the recorder shipped.");
    expect(calls[0].system).toMatch(/summarise meeting transcripts/i);
  });

  // Returning silently here is what made this invisible: the job completed, nothing was written
  // to the item, and the page said "No summary yet" for ever. On a Mac without Homebrew that is
  // permanent -- the 4.4 GB model downloads fine and there is no llama-cli to run it -- so the
  // reason has to reach the item, which is the one place the page already reads.
  it("records why on the item when there is no provider", async () => {
    const item = meeting();
    const logs: string[] = [];
    const handler = createSummarizeMeetingHandler({ db: t.db, provider: null, log: (m) => logs.push(m) });

    await handler(job(item.id));

    const meta = parseMeta<MeetingMeta>(getItem(t.db, item.id)!);
    expect(meta.summary).toBeUndefined();
    expect(meta.summaryError).toMatch(/summary model/i);
    expect(logs).toHaveLength(1);
  });

  it("records why when no local model resolves and no provider was injected", async () => {
    const item = meeting();
    const logs: string[] = [];
    const handler = createSummarizeMeetingHandler({ db: t.db, log: (m) => logs.push(m) });

    await handler(job(item.id));

    const meta = parseMeta<MeetingMeta>(getItem(t.db, item.id)!);
    expect(meta.summary).toBeUndefined();
    expect(meta.summaryError).toMatch(/summary model/i);
    expect(logs).toHaveLength(1);
  });

  it("records meta.summaryError and resolves when the provider fails", async () => {
    const item = meeting();
    const provider: ChatProvider = {
      structured: async () => {
        throw new Error("overloaded_error");
      },
    };
    const logs: string[] = [];
    const handler = createSummarizeMeetingHandler({ db: t.db, provider, log: (m) => logs.push(m) });

    await expect(handler(job(item.id))).resolves.toBeUndefined();

    const meta = parseMeta<MeetingMeta>(getItem(t.db, item.id)!);
    expect(meta.summaryError).toMatch(/overloaded_error/);
    expect(meta.summary).toBeUndefined();
    expect(logs).toHaveLength(1);
  });

  it("clears a previous summaryError on the next success", async () => {
    const item = meeting();
    const failing = createSummarizeMeetingHandler({
      db: t.db,
      provider: { structured: async () => { throw new Error("nope"); } },
      log: () => {},
    });
    await failing(job(item.id));
    expect(parseMeta<MeetingMeta>(getItem(t.db, item.id)!).summaryError).toBeTruthy();

    const ok = createSummarizeMeetingHandler({
      db: t.db,
      provider: { structured: async () => MeetingSummarySchema.parse(SUMMARY) as never },
    });
    await ok(job(item.id));

    const meta = parseMeta<MeetingMeta>(getItem(t.db, item.id)!);
    expect(meta.summaryError).toBeUndefined();
    expect(meta.summary).toEqual(MeetingSummarySchema.parse(SUMMARY));
  });

  it("skips an item with neither a transcript nor notes", async () => {
    const item = createItem(t.db, { type: "meeting", title: "Empty", body: "", status: "ready" });
    const structured = vi.fn();
    const logs: string[] = [];
    const handler = createSummarizeMeetingHandler({ db: t.db, provider: { structured }, log: (m) => logs.push(m) });

    await handler(job(item.id));

    expect(structured).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
  });
});

/**
 * A model that leaves `notes` off an action must still produce a usable summary. The alternative --
 * rejecting the whole answer -- loses the paragraph, the decisions and the actions over a missing
 * note, which is a worse trade every time.
 */
describe("a summary with an action that has no note", () => {
  it("fills the note in rather than rejecting the answer", () => {
    const parsed = MeetingSummarySchema.parse({
      summary: "What happened.",
      decisions: ["A choice"],
      proposed_actions: [{ title: "Do the thing" }],
    });
    expect(parsed.proposed_actions[0]).toEqual({ title: "Do the thing", notes: "" });
  });
});

/**
 * A transcript longer than the model's context window. `llama-cli` refuses such a prompt outright
 * -- it does not quietly drop the tokens that do not fit -- so the job splits the transcript and
 * summarises it in parts. Measured against the real model, the refusal arrives in about a second
 * and carries both token counts, which is what the split is sized from.
 */
describe("a transcript too long for one pass", () => {
  let t: TestDb;

  beforeEach(() => {
    t = makeTestDb();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    t.cleanup();
  });

  /** Long enough to need splitting, with a distinct, findable sentence every few hundred chars. */
  function longTranscript(sentences: number): string {
    return Array.from({ length: sentences }, (_, i) => `In part ${i} we agreed that item ${i} would be owned by person ${i}.`).join(" ");
  }

  function meeting(transcript: string, body = "") {
    const item = createItem(t.db, { type: "meeting", title: "Long workshop", body, status: "ready" });
    return updateItem(t.db, item.id, { extractedText: transcript });
  }

  /**
   * Stands in for llama-cli: refuses any prompt over `limit` characters the way the real binary
   * refuses one over its context window, reporting token counts derived from a fixed 4 characters
   * per token -- close to the 4.12 measured on a real transcript.
   */
  function sizeLimitedProvider(limit: number) {
    const seen: string[] = [];
    const provider: ChatProvider = {
      structured: async (req) => {
        seen.push(req.user);
        if (req.user.length > limit) {
          throw new ContextOverflowError(Math.round(req.user.length / 4), Math.round(limit / 4));
        }
        if (req.name === "record_meeting_narrative") return { summary: "One paragraph over the whole thing." } as never;
        // Echo something traceable back to the part that produced it.
        const marker = /item (\d+)/.exec(req.user);
        return {
          summary: `Part covering item ${marker?.[1] ?? "?"}.`,
          decisions: [`Item ${marker?.[1] ?? "?"} has an owner`],
          proposed_actions: [{ title: `Follow up on item ${marker?.[1] ?? "?"}`, notes: "" }],
        } as never;
      },
    };
    return { provider, seen };
  }

  function job(itemId: number): Job {
    return enqueueJob(t.db, "summarize_meeting", { itemId }, itemId);
  }

  it("splits, summarises each part, and records a summary rather than failing", async () => {
    const item = meeting(longTranscript(200));
    const { provider, seen } = sizeLimitedProvider(2000);
    const handler = createSummarizeMeetingHandler({ db: t.db, provider, log: () => {} });

    await handler(job(item.id));

    const meta = parseMeta<{ summary?: typeof SUMMARY; summaryError?: string; summaryParts?: unknown[]; summaryGaps?: string }>(getItem(t.db, item.id)!);
    expect(meta.summaryError).toBeUndefined();
    expect(meta.summaryGaps).toBeUndefined();
    expect(meta.summary?.summary).toBe("One paragraph over the whole thing.");
    expect(meta.summary!.decisions.length).toBeGreaterThan(1);
    // One refused whole-transcript attempt, then the parts, then the narrative pass.
    expect(seen.length).toBeGreaterThan(3);
  });

  it("keeps the per-part summaries, so coverage can be checked rather than trusted", async () => {
    const item = meeting(longTranscript(200));
    const { provider } = sizeLimitedProvider(2000);
    const handler = createSummarizeMeetingHandler({ db: t.db, provider, log: () => {} });

    await handler(job(item.id));

    const meta = parseMeta<{ summaryParts?: unknown[] }>(getItem(t.db, item.id)!);
    expect(meta.summaryParts?.length).toBeGreaterThan(1);
  });

  /** The property the whole design exists for: no part of the transcript goes unread. */
  it("shows every part of the transcript to the model", async () => {
    const item = meeting(longTranscript(120));
    const { provider, seen } = sizeLimitedProvider(2000);
    const handler = createSummarizeMeetingHandler({ db: t.db, provider, log: () => {} });

    await handler(job(item.id));

    const parts = seen.slice(1).join("\n");
    for (let i = 0; i < 120; i++) expect(parts).toContain(`In part ${i} we agreed`);
  });

  it("records a summary and says what is missing when one part fails", async () => {
    const item = meeting(longTranscript(200));
    let calls = 0;
    const provider: ChatProvider = {
      structured: async (req) => {
        calls++;
        if (req.user.length > 2000) throw new ContextOverflowError(Math.round(req.user.length / 4), 500);
        // The second part attempted fails for a reason splitting cannot fix.
        if (calls === 3) throw new Error("llama-cli failed: out of memory");
        if (req.name === "record_meeting_narrative") return { summary: "Most of the meeting." } as never;
        return { summary: "A part.", decisions: ["Something was settled"], proposed_actions: [] } as never;
      },
    };
    const handler = createSummarizeMeetingHandler({ db: t.db, provider, log: () => {} });

    await handler(job(item.id));

    const meta = parseMeta<{ summary?: typeof SUMMARY; summaryGaps?: string; summaryError?: string }>(getItem(t.db, item.id)!);
    expect(meta.summary).toBeDefined();
    expect(meta.summaryError).toBeUndefined();
    expect(meta.summaryGaps).toContain("could not be summarised");
    expect(meta.summaryGaps).toContain("out of memory");
  });

  it("falls back to the parts' own paragraphs when the narrative pass fails", async () => {
    const item = meeting(longTranscript(60));
    const provider: ChatProvider = {
      structured: async (req) => {
        if (req.user.length > 2000) throw new ContextOverflowError(Math.round(req.user.length / 4), 500);
        if (req.name === "record_meeting_narrative") throw new Error("llama-cli failed: no model");
        return { summary: "What this part covered.", decisions: [], proposed_actions: [] } as never;
      },
    };
    const handler = createSummarizeMeetingHandler({ db: t.db, provider, log: () => {} });

    await handler(job(item.id));

    const meta = parseMeta<{ summary?: typeof SUMMARY; summaryError?: string }>(getItem(t.db, item.id)!);
    expect(meta.summaryError).toBeUndefined();
    expect(meta.summary?.summary).toContain("What this part covered.");
  });

  it("records a plain failure when no part can be summarised at all", async () => {
    const item = meeting(longTranscript(200));
    const provider: ChatProvider = {
      structured: async (req) => {
        throw new ContextOverflowError(Math.round(req.user.length / 4), 10);
      },
    };
    const handler = createSummarizeMeetingHandler({ db: t.db, provider, log: () => {} });

    await handler(job(item.id));

    const meta = parseMeta<{ summary?: unknown; summaryError?: string }>(getItem(t.db, item.id)!);
    expect(meta.summary).toBeUndefined();
    expect(meta.summaryError).toContain("too long for one pass");
  });

  it("carries the notes through to a structured pass, not just the narrative", async () => {
    const item = meeting(longTranscript(200), "Remember to ask Priya about the rollback owner.");
    const { provider, seen } = sizeLimitedProvider(2000);
    const handler = createSummarizeMeetingHandler({ db: t.db, provider, log: () => {} });

    await handler(job(item.id));

    const structured = seen.filter((u) => u.includes("Transcript") || u.includes("Notes taken"));
    expect(structured.some((u) => u.includes("Remember to ask Priya"))).toBe(true);
  });
});
