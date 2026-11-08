import fs from "node:fs";
import { resolveTool } from "@/domain/meetings/tools";
import { chatProviderFor, localModelPath, roleStates } from "@/domain/models/resolve";
import type { ChatProvider } from "./types";

export type { ChatProvider, StructuredRequest } from "./types";

/** Where `scripts/brain.sh setup`'s `download_summary_model` step puts the model file. The
 * layout belongs to `@/domain/models/resolve` now, which is also the last of the three sources
 * that can answer this role -- this is a named alias so existing callers keep reading well. */
export function summaryModelPath(): string {
  return localModelPath("summary");
}

/** Whether the GGUF beside the app is there. Narrower than "can a summary be written", which
 * is `summaryUnavailable()`: a machine with a runtime and no local file answers false here and
 * can still write summaries perfectly well. */
export function hasSummaryModel(): boolean {
  return fs.existsSync(summaryModelPath());
}

export function summaryBinary(): string | null {
  return resolveTool("llama-cli");
}

/**
 * Null when nothing can answer the summary role: every caller already treats that as "this
 * feature is off, not broken".
 *
 * Async now, and delegating to `chatProviderFor`, because a role can be answered by a model
 * resident in a local runtime as well as by a GGUF beside the app -- and which one answers is a
 * question about `~/.config/local-models.json` and a port, not about one file on disk. There is
 * deliberately only this one way to build a provider: two paths to the same decision is how a
 * settings page and the job that reads it end up disagreeing.
 */
export async function getChatProvider(): Promise<ChatProvider | null> {
  return chatProviderFor("summary");
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
export async function summaryUnavailable(): Promise<string | null> {
  const states = await roleStates();
  return states.states.find((s) => s.role === "summary")?.unavailable ?? null;
}
