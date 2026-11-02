import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { getItem, parseMeta } from "@/domain/items";
import { listJobs } from "@/jobs/queue";
import { Recorder, type RecorderStatus } from "./recorder";
import { createAdhocMeeting } from "./index";
import type { LiveSegment } from "./live";
import { MeetingError } from "./errors";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_RECORDER = path.join(here, "..", "..", "test", "fake-recorder.js");
const FAKE_WHISPER = path.join(here, "..", "..", "test", "fake-whisper.js");

interface RecordingMeta {
  startedAt: string;
  endedAt?: string;
  wavPath: string;
  state: string;
  autoStarted: boolean;
}

function meta(t: TestDb, id: number): { recording?: RecordingMeta; liveTranscript?: LiveSegment[] } {
  return parseMeta(getItem(t.db, id)!);
}

/** Poll until `check` passes, so the test never sleeps longer than it has to. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for the condition");
}

describe("Recorder", () => {
  let t: TestDb;
  let filesDir: string;
  let model: string;
  let recorder: Recorder;

  function make(over: { whisperBin?: string | null; baseModel?: string | null; windowMs?: number; stopGraceMs?: number } = {}): Recorder {
    return new Recorder({
      db: t.db,
      recorderBin: FAKE_RECORDER,
      whisperBin: over.whisperBin === undefined ? null : over.whisperBin,
      baseModel: over.baseModel === undefined ? null : over.baseModel,
      filesDir,
      windowMs: over.windowMs,
      stopGraceMs: over.stopGraceMs,
    });
  }

  beforeEach(() => {
    t = makeTestDb();
    filesDir = path.join(t.dir, "files");
    fs.mkdirSync(filesDir, { recursive: true });
    model = path.join(t.dir, "ggml-base.en.bin");
    fs.writeFileSync(model, "not a real model");
    recorder = make();
  });

  afterEach(async () => {
    await recorder.stop();
    delete process.env.SB_FAKE_RECORDER_EXIT_MS;
    delete process.env.SB_FAKE_RECORDER_STALL_MS;
    delete process.env.SB_FAKE_RECORDER_KILL_MS;
    delete process.env.SB_FAKE_RECORDER_STOP_CODE;
    delete process.env.SB_FAKE_RECORDER_IGNORE_SIGNALS;
    delete process.env.SB_FAKE_RECORDER_SAY;
    delete process.env.SB_FAKE_RECORDER_FAIL_EARLY;
    t.cleanup();
  });

  it("starts a recording against an ad hoc meeting and writes the wav under the files dir", async () => {
    const item = createAdhocMeeting(t.db, new Date("2026-09-22T14:05:00"));
    expect(item.title).toBe("Meeting at 14:05");

    const started = recorder.start(item);
    expect(started.itemId).toBe(item.id);
    expect(recorder.status().state).toBe("recording");
    expect(recorder.status().title).toBe(item.title);

    const recording = meta(t, item.id).recording!;
    expect(recording.state).toBe("recording");
    expect(recording.startedAt).toBe(started.startedAt);
    expect(recording.wavPath.startsWith("meetings/")).toBe(true);
    await until(() => fs.existsSync(path.join(filesDir, recording.wavPath)));
    await until(() => recorder.status().systemAudio === true);
  });

  it("refuses a second session with a 409", () => {
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    const second = createAdhocMeeting(t.db, new Date());
    let thrown: unknown;
    try {
      recorder.start(second);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MeetingError);
    expect((thrown as MeetingError).status).toBe(409);
  });

  it("writes live transcript segments while it records", async () => {
    recorder = make({ whisperBin: FAKE_WHISPER, baseModel: model, windowMs: 200 });
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    await until(() => (meta(t, item.id).liveTranscript?.length ?? 0) > 0);
    const live = meta(t, item.id).liveTranscript!;
    expect(live[0].text).toBe("hello world");
    expect(typeof live[0].at).toBe("string");
  });

  it("stops, marks the recording done, and queues the final transcript", async () => {
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    const wav = path.join(filesDir, meta(t, item.id).recording!.wavPath);
    await until(() => fs.existsSync(wav) && fs.statSync(wav).size > 44);
    await recorder.stop();

    expect(recorder.status().state).toBe("idle");
    const recording = meta(t, item.id).recording!;
    expect(recording.state).toBe("done");
    expect(typeof recording.endedAt).toBe("string");
    const queued = listJobs(t.db, { itemId: item.id });
    expect(queued.map((j) => j.type)).toEqual(["transcribe_final"]);
    // `wavPath` is part of the payload on purpose: the job has to name the recording it was
    // queued for, or a job waiting behind a second session transcribes that session's audio.
    expect(JSON.parse(queued[0].payload)).toEqual({ itemId: item.id, source: "recording", wavPath: recording.wavPath });
    // The wav survives the stop: nothing recorded is thrown away.
    expect(fs.statSync(path.join(filesDir, recording.wavPath)).size).toBeGreaterThan(44);
  });

  it("keeps the recording when the helper dies, and still queues the transcript", async () => {
    process.env.SB_FAKE_RECORDER_EXIT_MS = "150";
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    await until(() => recorder.status().state === "error");

    const status = recorder.status();
    expect(status.itemId).toBe(item.id);
    expect(status.error).toMatch(/exited/);
    expect(meta(t, item.id).recording!.state).toBe("error");
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["transcribe_final"]);
  });

  it("treats a helper killed outright as a failure, and still queues the transcript", async () => {
    // SIGKILL leaves no exit code at all; nobody asked for it, so the session failed.
    process.env.SB_FAKE_RECORDER_KILL_MS = "150";
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    await until(() => recorder.status().state === "error");

    expect(recorder.status().error).toBe("recorder exited with SIGKILL");
    expect(meta(t, item.id).recording!.state).toBe("error");
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["transcribe_final"]);
  });

  it("carries the helper's last words into the failure, not just the signal", async () => {
    // A bare "exited with SIGABRT" is unactionable. When the helper manages to say why before it
    // dies -- an uncatchable CoreAudio abort prints to stderr first -- that line is the message.
    process.env.SB_FAKE_RECORDER_SAY = "libc++abi: terminating due to uncaught exception";
    process.env.SB_FAKE_RECORDER_KILL_MS = "150";
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    await until(() => recorder.status().state === "error");

    expect(recorder.status().error).toBe(
      "recorder exited with SIGKILL: libc++abi: terminating due to uncaught exception",
    );
  });

  // What a denied microphone actually looks like: the helper refuses before creating the file.
  // The reported reason has to survive, and nothing should be queued against audio that is not
  // there -- otherwise the item ends up blaming "the audio is missing" for a permission problem.
  it("keeps the helper's reason and queues nothing when no audio was ever written", async () => {
    process.env.SB_FAKE_RECORDER_FAIL_EARLY = "microphone access denied; allow it in System Settings";
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    await until(() => recorder.status().state === "error");

    expect(recorder.status().error).toBe("microphone access denied; allow it in System Settings");
    expect(listJobs(t.db, { itemId: item.id })).toEqual([]);
    expect(meta(t, item.id).recording!.state).toBe("error");
  });

  it("says so when it records without a live transcript, instead of degrading silently", async () => {
    // Recording and the final pass both still work here; only the live text is missing. Without
    // a word about it, "why is there no streaming transcript" has no answer from the outside.
    const lines: string[] = [];
    const quiet = new Recorder({
      db: t.db,
      recorderBin: FAKE_RECORDER,
      whisperBin: null,
      baseModel: null,
      filesDir,
      log: (m) => lines.push(m),
    });
    const item = createAdhocMeeting(t.db, new Date());
    quiet.start(item);
    await until(() => lines.some((l) => l.includes("no live transcript")));
    await quiet.stop();

    expect(lines.find((l) => l.includes("no live transcript"))).toContain("whisper-cli and the base.en model");
  });

  // A session that fails while the app is running must not leave the item in "processing"
  // forever: no transcript is queued when nothing was recorded, so nothing else would move it.
  it("does not leave a failed session stuck in processing", async () => {
    process.env.SB_FAKE_RECORDER_FAIL_EARLY = "microphone access denied";
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    await until(() => recorder.status().state === "error");

    expect(getItem(t.db, item.id)!.status).toBe("ready");
    expect(meta(t, item.id).recording!.state).toBe("error");
  });

  it("treats a helper that dies badly while stopping as a failure", async () => {
    // The stop was asked for, but the helper still went down with an error: the session failed.
    process.env.SB_FAKE_RECORDER_STOP_CODE = "3";
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    // "recording" on stderr means the helper is fully up, handlers included, not merely that its file exists.
    await until(() => recorder.status().state === "recording" && fs.existsSync(path.join(filesDir, meta(t, item.id).recording!.wavPath)));
    await recorder.stop();

    expect(recorder.status().state).toBe("error");
    expect(recorder.status().error).toBe("recorder exited with 3");
    expect(meta(t, item.id).recording!.state).toBe("error");
    // The WAV is still on disk, so it still gets its final pass.
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["transcribe_final"]);
  });

  /**
   * The ladder used to stop at SIGTERM. A helper that ignores it -- wedged inside a CoreAudio
   * call that never returns is how that happens -- left this promise unresolved for ever: the
   * Stop request never came back, the chip stayed on "stopping", and nothing could record again
   * until the server was restarted.
   */
  it("kills a helper that ignores both signals rather than waiting on it for ever", async () => {
    process.env.SB_FAKE_RECORDER_IGNORE_SIGNALS = "1";
    recorder = make({ stopGraceMs: 80 });
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    await until(() => recorder.status().state === "recording" && fs.existsSync(path.join(filesDir, meta(t, item.id).recording!.wavPath)));

    await recorder.stop();

    // The session is over either way, and the audio that was written still gets its final pass.
    await until(() => recorder.status().state === "idle" || recorder.status().state === "error");
    await until(() => listJobs(t.db, { itemId: item.id }).some((j) => j.type === "transcribe_final"));
  });

  it("records a stalled stdout consumer without losing the session", async () => {
    process.env.SB_FAKE_RECORDER_STALL_MS = "120";
    recorder = make({ whisperBin: FAKE_WHISPER, baseModel: model, windowMs: 200 });
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    await until(() => recorder.status().error === "stdout consumer stalled");
    expect(recorder.status().state).toBe("recording");
  });

  it("emits change as the session moves", async () => {
    const seen: RecorderStatus[] = [];
    recorder.on("change", (s: RecorderStatus) => seen.push(s));
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item);
    await recorder.stop();
    expect(seen.map((s) => s.state)).toEqual(["recording", "stopping", "idle"]);
  });

  it("marks the session kept", () => {
    const item = createAdhocMeeting(t.db, new Date());
    recorder.start(item, { autoStarted: true });
    expect(recorder.status().autoStarted).toBe(true);
    expect(recorder.keep().keep).toBe(true);
    expect(recorder.status().keep).toBe(true);
  });
});
