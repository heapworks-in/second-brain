import fs from "node:fs";
import path from "node:path";
import { modelsDir } from "@/lib/paths";
import { resolveTool } from "@/domain/meetings/tools";
import type { ChatProvider } from "@/providers/chat/types";
import { createLlamaCppChatProvider } from "@/providers/chat/llamacpp";
import { createLlamaCppGistProvider } from "@/providers/gist/llamacpp";
import type { GistProvider } from "@/providers/gist/types";
import { MODEL_ROLES, ROLE_LABELS, readConfig, runtimeUrl, type ModelRole, type ModelsConfig } from "./config";
import { createOllamaChatProvider, probeRuntime, type RuntimeModel } from "./ollama";
import { createOllamaGistProvider } from "./ollama-gist";

/** Where `scripts/brain.sh setup` puts each role's own GGUF — the layout both existing providers
 * already use, kept as the last resort so a machine with no config and no runtime still works. */
export function localModelPath(role: ModelRole): string {
  return path.join(modelsDir(), role, "model.gguf");
}

export type RoleSource = "config" | "runtime" | "local" | "none";

export interface RoleState {
  role: ModelRole;
  /** Which of the three sources answers this role right now. */
  source: RoleSource;
  /** The model that answers it: a runtime model name, a file path, or null when nothing does. */
  model: string | null;
  /** What the file asks for, whether or not the runtime has it — so the page can say "configured
   * but missing" rather than silently falling through and looking like nothing was ever set. */
  wanted: string | null;
  /** Why this role cannot answer, in words the page can show. Null when it can. */
  unavailable: string | null;
}

/**
 * Which source answers one role, and why.
 *
 * Three sources, in this order, because a public dmg has to work on a machine with no config
 * file, no runtime and no Homebrew:
 *
 * 1. **The file**, when it names this role *and* the runtime actually holds that model. A config
 *    naming a model nobody pulled is reported as configured-but-missing rather than used: the
 *    alternative is a job that completes having done nothing, which is the exact failure
 *    `summaryUnavailable()` was written to stop happening silently.
 * 2. **The runtime**, when it answers and holds exactly one model. One, not "the first" — picking
 *    among several without being told is a guess, and a guess about which model wrote your
 *    meeting summaries is not a guess worth making on somebody's behalf.
 * 3. **The local GGUF** plus a `llama-cli` on `PATH`, which is what the app does today.
 */
export interface ResolveInput {
  role: ModelRole;
  config: ModelsConfig;
  /** What the runtime holds. Empty when it is not reachable. */
  available: RuntimeModel[];
  runtimeReachable: boolean;
  /** The `llama-cli` that would run a local GGUF, or null. Passed in rather than looked up here
   * so this function is a pure decision and a test does not depend on what this machine has
   * installed. */
  llamaCli: string | null;
}

export function resolveRole({ role, config, available, runtimeReachable, llamaCli }: ResolveInput): RoleState {
  const wanted = config.roles?.[role]?.model ?? null;
  const has = (name: string) => available.some((m) => m.name === name);
  // Every sentence below names the role and ends in something to do about it. A reason that only
  // reports a state is how "No summary yet" came to sit on every meeting for ever.
  const name = ROLE_LABELS[role].title.toLowerCase();

  if (wanted) {
    if (has(wanted)) return { role, source: "config", model: wanted, wanted, unavailable: null };
    if (!runtimeReachable) {
      return {
        role,
        source: "none",
        model: null,
        wanted,
        unavailable: `${wanted} is configured for the ${name} model, but the runtime at ${runtimeUrl(config)} is not reachable — start it, or choose a different model in Settings › Models`,
      };
    }
    return {
      role,
      source: "none",
      model: null,
      wanted,
      unavailable: `${wanted} is configured for the ${name} model, but the runtime does not have it — pull it, or choose another in Settings › Models`,
    };
  }

  if (runtimeReachable && available.length === 1) {
    return { role, source: "runtime", model: available[0].name, wanted, unavailable: null };
  }

  const file = localModelPath(role);
  if (fs.existsSync(file)) {
    if (llamaCli) return { role, source: "local", model: file, wanted, unavailable: null };
    return {
      role,
      source: "none",
      model: null,
      wanted,
      unavailable: `the ${name} model is installed, but llama-cli is not there to run it — install Homebrew, then run brew install llama.cpp`,
    };
  }

  if (runtimeReachable && available.length > 1) {
    return {
      role,
      source: "none",
      model: null,
      wanted,
      unavailable: `no ${name} model is chosen yet — pick one of the ${available.length} models your runtime holds, in Settings › Models`,
    };
  }
  return {
    role,
    source: "none",
    model: null,
    wanted,
    unavailable: `no ${name} model is installed yet — install one in Settings › Setup, or point this role at a model a local runtime already holds`,
  };
}

/** Every role's state in one pass, so the settings page probes the runtime once rather than
 * once per row. */
export async function roleStates(): Promise<{ states: RoleState[]; runtime: Awaited<ReturnType<typeof probeRuntime>>; configError: string | null; url: string }> {
  const { config, error } = readConfig();
  const url = runtimeUrl(config);
  const runtime = await probeRuntime(url);
  return {
    states: MODEL_ROLES.map((role) => resolveRole({ role, config, available: runtime.models, runtimeReachable: runtime.reachable, llamaCli: resolveTool("llama-cli") })),
    runtime,
    configError: error,
    url,
  };
}

/** One role's provider, or null — "this feature is off, not broken", which is what every caller
 * of `getChatProvider` already means by null. */
export async function chatProviderFor(role: ModelRole): Promise<ChatProvider | null> {
  const { config, error } = readConfig();
  void error;
  const url = runtimeUrl(config);
  const wanted = config.roles?.[role]?.model;

  // The probe is skipped entirely when nothing wants the runtime and a local model is there: a
  // summary job should not wait on an HTTP timeout to use the file beside it.
  if (wanted || !fs.existsSync(localModelPath(role))) {
    const runtime = await probeRuntime(url);
    const state = resolveRole({ role, config, available: runtime.models, runtimeReachable: runtime.reachable, llamaCli: resolveTool("llama-cli") });
    if (state.source === "config" || state.source === "runtime") return createOllamaChatProvider(url, state.model!);
    if (state.source === "none") return null;
  }

  const bin = resolveTool("llama-cli");
  if (!bin) return null;
  return createLlamaCppChatProvider(localModelPath(role), bin);
}

/**
 * The gist role's provider. Separate from `chatProviderFor` because a gist is a line of prose
 * rather than a structured answer, so it is a different interface over the same choice of model.
 */
export async function gistProviderFor(): Promise<GistProvider | null> {
  const { config } = readConfig();
  const url = runtimeUrl(config);
  const wanted = config.roles?.gist?.model;
  if (wanted) {
    const runtime = await probeRuntime(url);
    const state = resolveRole({ role: "gist", config, available: runtime.models, runtimeReachable: runtime.reachable, llamaCli: resolveTool("llama-cli") });
    if (state.source === "config" || state.source === "runtime") return createOllamaGistProvider(url, state.model!);
    return null;
  }
  const file = localModelPath("gist");
  const bin = resolveTool("llama-cli");
  if (!fs.existsSync(file) || !bin) return null;
  return createLlamaCppGistProvider(file, bin);
}
