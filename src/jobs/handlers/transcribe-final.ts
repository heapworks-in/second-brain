import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DB } from "@/db/client";
import type { JobHandler } from "@/jobs/worker";
import { jobPayload } from "@/jobs/payload";
import { enqueueJob } from "@/jobs/queue";
import { getItem, parseMeta, rechunkItem, updateItem } from "@/domain/items";
import { checkTools } from "@/domain/meetings/tools";
import { parseWhisperJson, segmentsToText, type Segment } from "@/domain/meetings/transcript";
import type { RecordingMeta } from "@/domain/meetings/recorder";
import { SAMPLE_RATE } from "@/domain/meetings/live";
import { absoluteFilePath } from "@/lib/files";

const run = promisify(execFile);

/** A medium-model pass over an hour of audio is minutes, not seconds. */
const WHISPER_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

export interface TranscribeFinalDeps {
  db: DB;
  /** Injectable so tests never reach for what is installed on the machine. */
  whisperBin?: string | null;
  ffmpegBin?: string | null;
  finalModel?: string | null;
}

interface MeetingMeta {
  recording?: RecordingMeta;
  transcript?: Segment[];
  final_transcript_ready?: boolean;
  /** What the live pass heard while the meeting ran, kept alongside the final transcript rather
   * than replaced by it. */
  liveTranscript?: unknown;
}

/** True when the file is already what whisper wants: 16 kHz mono 16-bit PCM in a RIFF wrapper. */
export function isWhisperReadyWav(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(44);
    if (fs.readSync(fd, head, 0, 44, 0) < 44) return false;
    if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") return false;
    return head.readUInt16LE(20) === 1 && head.readUInt16LE(22) === 1 && head.readUInt32LE(24) === SAMPLE_RATE && head.readUInt16LE(34) === 16;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Thrown once the item is already marked failed, so the catch below does not do it twice. */
class TranscriptFailure extends Error {}

/**
 * The final transcript: whisper's larger model over the whole recording, replacing whatever
 * the live pass guessed at. It runs for a session the recorder finished and for audio that
 * was dropped in, which is the only difference between the two sources.
 */
export function createTranscribeFinalHandler(deps: TranscribeFinalDeps): JobHandler {
  const { db } = deps;

  function fail(itemId: number, message: string): never {
    updateItem(db, itemId, { status: "failed", error: message });
    throw new TranscriptFailure(message);
  }

  return async (job) => {
    const { itemId, wavPath } = jobPayload<{ itemId: number; source?: string; wavPath?: string }>(job);
    const item = getItem(db, itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    const meta = parseMeta<MeetingMeta>(item);
    // The payload's path wins: it names the recording this job was queued for. Falling back to the
    // item's current one would, for a job that waited behind a second session, transcribe that
    // session's audio and file it as this one's. Older jobs queued before the payload carried it
    // still fall through to the item.
    const relative = wavPath ?? meta.recording?.wavPath ?? item.filePath;
    if (!relative) fail(itemId, `Item ${itemId} has no audio to transcribe`);
    const source = absoluteFilePath(relative);
    if (!fs.existsSync(source)) fail(itemId, `The audio for item ${itemId} is missing: ${relative}`);

    // Only asked for when something was not injected, so a test never reads the real machine.
    let found: ReturnType<typeof checkTools> | null = null;
    const tools = () => (found ??= checkTools(db));
    const whisper = deps.whisperBin !== undefined ? deps.whisperBin : tools().whisper;
    const model = deps.finalModel !== undefined ? deps.finalModel : tools().finalModel;
    if (!whisper) fail(itemId, "whisper-cli is not installed; run the setup script");
    if (!model) fail(itemId, "The whisper model for final transcripts is missing; run the setup script");

    updateItem(db, itemId, { status: "processing", error: null });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sb-transcript-"));
    const base = path.join(scratch, "transcript");
    try {
      let audio = source;
      if (!isWhisperReadyWav(source)) {
        const ffmpeg = deps.ffmpegBin !== undefined ? deps.ffmpegBin : tools().ffmpeg;
        if (!ffmpeg) fail(itemId, "ffmpeg is not installed, and this audio needs converting; run the setup script");
        audio = path.join(scratch, "input.wav");
        await run(ffmpeg, ["-y", "-i", source, "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", audio], {
          timeout: FFMPEG_TIMEOUT_MS,
        });
      }

      await run(whisper, ["-m", model, "-f", audio, "-l", "en", "-oj", "-of", base], { timeout: WHISPER_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
      const segments = parseWhisperJson(fs.readFileSync(`${base}.json`, "utf8"));

      // The live pass is kept, not discarded. It used to be deleted here as "guesses that have
      // served their purpose", but it is the only record of what was heard as it happened: the
      // final pass is a fresh transcription of the audio, so when it mishears something there is
      // otherwise nothing left to compare against, and once the audio is released under the
      // retention rule it cannot be redone at all. It is a few KB of text.
      const next: MeetingMeta = { ...meta, transcript: segments, final_transcript_ready: true };
      updateItem(db, itemId, { extractedText: segmentsToText(segments), status: "ready", error: null, meta: next as Record<string, unknown> });
      rechunkItem(db, itemId);
      enqueueJob(db, "embed", { itemId }, itemId);
      // Queued unconditionally. This used to be gated on the summary model being installed *at
      // this instant*, and nothing ever queued one later: a meeting recorded while the app was
      // still downloading its 4.4 GB model got no summary, no error, and no second chance. The
      // handler already degrades to recording a reason on the item when it has nothing to run,
      // which is a state the page can show and a person can retry.
      enqueueJob(db, "summarize_meeting", { itemId }, itemId);
    } catch (err) {
      if (err instanceof TranscriptFailure) throw err;
      fail(itemId, err instanceof Error ? err.message : String(err));
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  };
}
