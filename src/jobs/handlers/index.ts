import type { DB } from "@/db/client";
import type { JobHandlers } from "@/jobs/worker";
import type { EmbedProvider } from "@/providers/embed/types";
import type { FetchLike } from "@/domain/items/links";
import type { PdfExtractFn, OcrFn } from "@/domain/items/extract";
import type { ChatProvider } from "@/providers/chat";
import { createEmbedHandler } from "./embed";
import { createFetchLinkHandler } from "./fetch-link";
import { createExtractPdfHandler } from "./extract-pdf";
import { createOcrImageHandler } from "./ocr-image";
import { createBackupHandler } from "./backup";
import { createTranscribeFinalHandler } from "./transcribe-final";
import { createSummarizeMeetingHandler } from "./summarize-meeting";
import { createDistillNoteHandler } from "./distill-note";

export interface HandlerDeps {
  db: DB;
  embed: EmbedProvider | null;
  fetchImpl?: FetchLike;
  extractPdf?: PdfExtractFn;
  ocr?: OcrFn;
  /** The meeting tools, injectable so tests never reach for what is installed. */
  whisperBin?: string | null;
  ffmpegBin?: string | null;
  /** Left out, the summary job resolves a provider from the local model when it runs. */
  chatProvider?: ChatProvider | null;
}

export function createJobHandlers(deps: HandlerDeps): JobHandlers {
  return {
    embed: createEmbedHandler({ db: deps.db, embed: deps.embed }),
    fetch_link: createFetchLinkHandler({ db: deps.db, fetchImpl: deps.fetchImpl }),
    extract_pdf: createExtractPdfHandler({ db: deps.db, extract: deps.extractPdf }),
    ocr_image: createOcrImageHandler({ db: deps.db, ocr: deps.ocr }),
    transcribe_final: createTranscribeFinalHandler({
      db: deps.db,
      whisperBin: deps.whisperBin,
      ffmpegBin: deps.ffmpegBin,
    }),
    summarize_meeting: createSummarizeMeetingHandler({ db: deps.db, provider: deps.chatProvider }),
    distill_note: createDistillNoteHandler({ db: deps.db }),
    backup: createBackupHandler({ db: deps.db }),
  };
}
