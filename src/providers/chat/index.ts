import fs from "node:fs";
import path from "node:path";
import { modelsDir } from "@/lib/paths";
import { resolveTool } from "@/domain/meetings/tools";
import { createLlamaCppChatProvider } from "./llamacpp";
import type { ChatProvider } from "./types";

export type { ChatProvider, StructuredRequest } from "./types";

/** Where `scripts/brain.sh setup`'s `download_summary_model` step puts the model file -- the
 * same layout src/providers/gist/index.ts uses for its own, smaller model. */
export function summaryModelPath(): string {
  return path.join(modelsDir(), "summary", "model.gguf");
}

/** A missing model means this feature is off, not broken -- same shape as `hasGistModel`. */
export function hasSummaryModel(): boolean {
  return fs.existsSync(summaryModelPath());
}

export function summaryBinary(): string | null {
  return resolveTool("llama-cli");
}

/** Null when the model or the binary is absent: every caller (today, just summarize-meeting.ts)
 * already treats that as "this feature is off" -- it used to mean no Anthropic key, now it means
 * no local model yet. */
export function getChatProvider(): ChatProvider | null {
  if (!hasSummaryModel()) return null;
  const bin = summaryBinary();
  if (!bin) return null;
  return createLlamaCppChatProvider(summaryModelPath(), bin);
}

/**
 * Why a summary cannot be written right now, in words the meeting page can show, or null when
 * one can.
 *
 * The model file and the binary that runs it are installed by two independent steps, and they
 * fail independently: `ensure_llama_cli` gives up with a log line on a Mac without Homebrew
 * while `fetch_model` still downloads all 4.4 GB of the model beside it. That left
 * `hasSummaryModel()` true, `getChatProvider()` null, and a summary job that completed having
 * done nothing at all -- so the page said "No summary yet" for ever, and nothing anywhere said
 * why. A reason the person can act on is the whole point of this function.
 */
export function summaryUnavailable(): string | null {
  if (!hasSummaryModel()) return "the local summary model is not installed yet — it is a 4.4 GB download the app fetches in the background";
  if (!summaryBinary()) return "llama-cli is not installed, so the summary model has nothing to run it: install Homebrew, then run brew install llama.cpp";
  return null;
}
