import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { filesDir } from "./paths";

export interface SavedFile {
  relativePath: string;
  absolutePath: string;
}

export type FileKind = "pdf" | "image" | "audio" | "text" | "other";

const AUDIO_EXT = new Set([".m4a", ".mp3", ".wav", ".webm", ".aac", ".ogg", ".flac"]);

/**
 * Plain-text documents, which need reading rather than extracting.
 *
 * Worth its own kind because the alternative is silent: a `.md` file used to be saved, chunked
 * from `title + body + extractedText` -- all three empty for a file -- and indexed as zero
 * chunks. It appeared in the library, it opened, and it could never be found by searching for a
 * word inside it.
 */
const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".rst", ".org", ".adoc", ".log", ".json", ".yaml", ".yml", ".csv", ".tsv"]);

export function saveFile(bytes: Buffer, originalName: string, now: Date = new Date()): SavedFile {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const safe = originalName.replace(/[^\w.\-]+/g, "_").slice(-120) || "file";
  const relativePath = path.join(yyyy, mm, `${randomUUID()}-${safe}`);
  const absolutePath = path.join(filesDir(), relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  return { relativePath, absolutePath };
}

export function absoluteFilePath(relativePath: string): string {
  return path.join(filesDir(), relativePath);
}

export function kindForMime(mime: string, name: string): FileKind {
  const ext = path.extname(name).toLowerCase();
  const m = mime.toLowerCase();
  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/") || AUDIO_EXT.has(ext)) return "audio";
  if (m.startsWith("text/") || TEXT_EXT.has(ext)) return "text";
  return "other";
}
