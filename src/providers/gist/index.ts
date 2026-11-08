import fs from "node:fs";
import { resolveTool } from "@/domain/meetings/tools";
import { gistProviderFor, localModelPath } from "@/domain/models/resolve";
import type { GistProvider } from "./types";

export type { GistProvider } from "./types";

/** Where `scripts/brain.sh setup`'s `download_gist_model` step puts the model file — the last of
 * the three sources `@/domain/models/resolve` can answer this role from. */
export function gistModelPath(): string {
  return localModelPath("gist");
}

/** Whether the GGUF beside the app is there. Narrower than "can a gist be written": a machine
 * with a runtime and no local file answers false here and gists perfectly well. */
export function hasGistModel(): boolean {
  return fs.existsSync(gistModelPath());
}

export function gistBinary(): string | null {
  return resolveTool("llama-cli");
}

/**
 * Null when nothing can answer the gist role: every caller treats that as "this feature is off",
 * which is why a bare, unresolved `llama-cli` must never reach a job handler and throw ENOENT
 * inside a real distillation.
 *
 * Async now, and delegating to the resolver, for the same reason the chat provider does: which
 * model answers a role is a question about `~/.config/local-models.json` and a port as much as
 * about a file on disk, and there must be exactly one place that decides.
 */
export async function getGistProvider(): Promise<GistProvider | null> {
  return gistProviderFor();
}
