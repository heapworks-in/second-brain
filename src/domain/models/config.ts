import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Which local model plays which role, in a file outside this application.
 *
 * `~/.config/local-models.json`, deliberately not the `settings` table. Every other setting in
 * this app lives in SQLite; this one cannot, because the entire point is that other applications
 * can read the same answer, and a row in second-brain's database is unreachable to them.
 *
 * Roles rather than model names in application code: a caller asks for "the summariser" and this
 * file decides what that is today. Swapping a model is one line here, no rebuild anywhere, and
 * every application reading the file follows.
 */
export const MODEL_ROLES = ["summary", "gist"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** What each role is for, in the words the settings page shows. */
export const ROLE_LABELS: Record<ModelRole, { title: string; what: string }> = {
  summary: { title: "Summary", what: "Meeting summaries, decisions and proposed actions" },
  gist: { title: "Gist", what: "One-line gists of notes, and the distil sweep" },
};

const RoleConfig = z.object({ model: z.string().min(1).max(200) }).strict();

export const ModelsConfig = z
  .object({
    runtime: z
      .object({
        kind: z.literal("ollama"),
        url: z.string().url().max(500),
      })
      .strict()
      .optional(),
    // `partialRecord`, not `record`: a record keyed by an enum is exhaustive in Zod 4, which
    // would demand every role be present in a file whose whole point is that you configure the
    // one you care about. An unknown role is still refused, so a typo in a hand-edited file is
    // reported rather than silently doing nothing.
    roles: z.partialRecord(z.enum(MODEL_ROLES), RoleConfig).optional(),
  })
  .strict();

export type ModelsConfig = z.infer<typeof ModelsConfig>;

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/** Overridable for tests, and for anyone who keeps their config somewhere else. */
export function configPath(): string {
  return process.env.SB_MODELS_CONFIG ?? path.join(os.homedir(), ".config", "local-models.json");
}

/** The one-level backup a write leaves behind, which is what Revert reads. */
export function backupPath(): string {
  return `${configPath()}.bak`;
}

/**
 * Read the file, or an empty config.
 *
 * Every failure reads as "nothing configured": no file, bad JSON, a shape this version does not
 * understand. A hand-edited file with a typo in it must not take the app down -- the roles fall
 * through to the next source in `resolveRole`, which is exactly what happens on a machine that
 * never had the file at all.
 */
export function readConfig(file = configPath()): { config: ModelsConfig; error: string | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { config: {}, error: null };
  }
  try {
    const parsed = ModelsConfig.parse(JSON.parse(raw));
    return { config: parsed, error: null };
  } catch (err) {
    // Reported rather than thrown: the settings page says the file is unreadable and why, which
    // is the only way someone finds a typo in a file no UI wrote.
    return { config: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write the file, keeping the previous version beside it.
 *
 * The backup is taken before the write and not after, so an interrupted write never leaves both
 * files new. One level of history on purpose: this file has four lines in it, and somebody who
 * wants the version from three weeks ago wants their own backups, not ours.
 */
export function writeConfig(config: ModelsConfig, file = configPath()): void {
  const parsed = ModelsConfig.parse(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  } catch {
    // A backup that cannot be taken is not a reason to refuse the change; the page's Revert
    // simply has nothing to offer, which it reports by being absent.
  }
  // Written whole through a temp file and renamed, so a reader never sees half a config -- other
  // applications read this file and have no way to know we were mid-write.
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function hasBackup(file = configPath()): boolean {
  return fs.existsSync(`${file}.bak`);
}

/** Put the previous version back, and keep no backup of the revert: a Revert that could itself
 * be reverted is a history, and this is one level by design. */
export function revertConfig(file = configPath()): boolean {
  const backup = `${file}.bak`;
  if (!fs.existsSync(backup)) return false;
  fs.renameSync(backup, file);
  return true;
}

/**
 * Where the runtime is: the file first, then `SB_OLLAMA_URL`, then the default port.
 *
 * The file wins because it is the thing the settings page manages and the thing other
 * applications read. The environment variable sits underneath as a default, which is what lets
 * someone run a runtime on another host without editing the file — and what keeps the test suite
 * from probing whatever the developer happens to have listening on 11434.
 */
export function runtimeUrl(config: ModelsConfig): string {
  return config.runtime?.url ?? process.env.SB_OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
}
