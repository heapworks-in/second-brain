import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { createItem, getItem, getItemChunks, parseMeta, updateItem } from "@/domain/items";
import { enqueueJob, listJobs } from "@/jobs/queue";
import { filesDir } from "@/lib/paths";
import type { Segment } from "@/domain/meetings/transcript";
import { queueFinalTranscript } from "@/domain/meetings/recorder";
import { createTranscribeFinalHandler } from "./transcribe-final";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_WHISPER = path.join(here, "..", "..", "test", "fake-whisper.js");
const FAKE_FFMPEG = path.join(here, "..", "..", "test", "fake-ffmpeg.js");

const TRANSCRIPT = "Hello world this is the meeting";

/** A 16 kHz mono WAV of silence, the shape the recorder writes. */
function writeWav(relative: string, frames = 16000): string {
  const data = Buffer.alloc(frames * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  const abs = path.join(filesDir(), relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.concat([head, data]));
  return relative;
}

interface MeetingMeta {
  transcript?: Segment[];
  final_transcript_ready?: boolean;
  liveTranscript?: unknown;
  recording?: { wavPath: string; state: string };
}

describe("transcribe_final handler", () => {
  let t: TestDb;
  let model: string;

  function handler(over: { ffmpegBin?: string | null } = {}) {
    return createTranscribeFinalHandler({
      db: t.db,
      whisperBin: FAKE_WHISPER,
      ffmpegBin: over.ffmpegBin === undefined ? null : over.ffmpegBin,
      finalModel: model,
    });
  }

  beforeEach(() => {
    t = makeTestDb();
    model = path.join(t.dir, "ggml-medium.en.bin");
    fs.writeFileSync(model, "not a real model");
  });
  afterEach(() => t.cleanup());

  it("transcribes a recorded wav, chunks it, and queues the embedding", async () => {
    const wavPath = writeWav(path.join("meetings", "1-recording.wav"));
    const item = createItem(t.db, {
      type: "meeting",
      title: "Standup",
      status: "processing",
      meta: { recording: { wavPath, state: "done" }, liveTranscript: [{ at: "2026-09-22T10:00:00.000Z", text: "hello" }] },
    });
    const job = enqueueJob(t.db, "transcribe_final", { itemId: item.id, source: "recording" }, item.id);

    await handler()(job);

    const after = getItem(t.db, item.id)!;
    expect(after.extractedText).toBe(TRANSCRIPT);
    expect(after.status).toBe("ready");
    const m = parseMeta<MeetingMeta>(after);
    expect(m.transcript).toEqual([
      { start: 0, end: 1.5, text: "Hello world" },
      { start: 1.5, end: 3, text: "this is the meeting" },
    ]);
    expect(m.final_transcript_ready).toBe(true);
    // The live pass is the only record of what was heard as it happened; the final transcript is
    // a fresh pass over the audio, so keeping both is what makes a mishearing checkable at all --
    // and the audio itself is released on a retention timer.
    expect(m.liveTranscript).toEqual([{ at: "2026-09-22T10:00:00.000Z", text: "hello" }]);
    expect(getItemChunks(t.db, item.id).length).toBeGreaterThan(0);
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["transcribe_final", "embed", "summarize_meeting"]);
  });

  // The summary used to be queued only when the model happened to be installed at this instant,
  // and nothing ever queued one later: a meeting recorded while the app was still fetching its
  // 4.4 GB model lost its summary permanently, with no error and no second chance. The handler
  // itself records a reason when it has nothing to run, which is a state a person can see.
  it("queues a summary whatever is installed, so the window can never be missed", async () => {
    const wavPath = writeWav(path.join("meetings", "2-recording.wav"));
    const item = createItem(t.db, { type: "meeting", title: "Standup", meta: { recording: { wavPath, state: "done" } } });
    const job = enqueueJob(t.db, "transcribe_final", { itemId: item.id, source: "recording" }, item.id);

    await handler()(job);

    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["transcribe_final", "embed", "summarize_meeting"]);
  });

  it("converts a dropped-in audio file before transcribing it", async () => {
    const relative = path.join("2026", "09", "talk.m4a");
    const abs = path.join(filesDir(), relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from("not really audio"));
    const item = createItem(t.db, { type: "meeting", title: "talk", filePath: relative, mimeType: "audio/mp4", status: "processing" });
    const job = enqueueJob(t.db, "transcribe_final", { itemId: item.id, source: "upload" }, item.id);

    await handler({ ffmpegBin: FAKE_FFMPEG })(job);

    expect(getItem(t.db, item.id)!.extractedText).toBe(TRANSCRIPT);
    // The original upload is still the item's file: the conversion is scratch.
    expect(getItem(t.db, item.id)!.filePath).toBe(relative);
    expect(fs.existsSync(abs)).toBe(true);
  });

  it("fails the item with a message when the audio is gone", async () => {
    const item = createItem(t.db, {
      type: "meeting",
      title: "Standup",
      meta: { recording: { wavPath: path.join("meetings", "missing.wav"), state: "done" } },
    });
    const job = enqueueJob(t.db, "transcribe_final", { itemId: item.id, source: "recording" }, item.id);

    await expect(handler()(job)).rejects.toThrow(/audio/i);
    const after = getItem(t.db, item.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/audio/i);
  });

  it("fails the item when nothing on it points at audio", async () => {
    const item = createItem(t.db, { type: "meeting", title: "Standup" });
    const job = enqueueJob(t.db, "transcribe_final", { itemId: item.id }, item.id);
    await expect(handler()(job)).rejects.toThrow(/audio/i);
    expect(getItem(t.db, item.id)!.status).toBe("failed");
  });

  it("fails the item when whisper is not installed", async () => {
    const wavPath = writeWav(path.join("meetings", "3-recording.wav"));
    const item = createItem(t.db, { type: "meeting", title: "Standup", meta: { recording: { wavPath, state: "done" } } });
    const job = enqueueJob(t.db, "transcribe_final", { itemId: item.id, source: "recording" }, item.id);
    const run = createTranscribeFinalHandler({ db: t.db, whisperBin: null, ffmpegBin: null, finalModel: model });
    await expect(run(job)).rejects.toThrow(/whisper/i);
    expect(getItem(t.db, item.id)!.status).toBe("failed");
  });
});

/**
 * The queue is serial and a job can wait in it. Re-reading `meta.recording.wavPath` when the job
 * finally runs means a job queued for one session can transcribe a *later* session's audio and
 * file it as the first one's -- a previous meeting's words, under this meeting's name. The path
 * travels in the payload so the job stays about the recording it was queued for.
 */
describe("a job that waited behind a second recording", () => {
  let t2: TestDb;
  beforeEach(() => {
    t2 = makeTestDb();
  });
  afterEach(() => {
    t2.cleanup();
  });

  it("is queued against the wav that existed at the time, not whatever the item points at later", () => {
    const item = createItem(t2.db, { type: "meeting", title: "Weekly", status: "processing" });
    updateItem(t2.db, item.id, { meta: { recording: { wavPath: "meetings/first.wav", state: "done" } } });

    queueFinalTranscript(t2.db, item.id);

    // A second session replaces what the item points at, before the job is claimed.
    updateItem(t2.db, item.id, { meta: { recording: { wavPath: "meetings/second.wav", state: "recording" } } });

    const queued = listJobs(t2.db).find((j) => j.type === "transcribe_final");
    expect(queued).toBeTruthy();
    expect(JSON.parse(queued!.payload).wavPath).toBe("meetings/first.wav");
  });
});
