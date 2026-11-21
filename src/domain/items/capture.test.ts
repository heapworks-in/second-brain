import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { makeTestDb, type TestDb } from "@/test/db";
import { MINIMAL_PDF } from "@/test/fixtures";
import { listJobs } from "@/jobs/queue";
import { getItemChunks, getItemTags } from "./index";
import { absoluteFilePath } from "@/lib/files";
import { captureNote, captureLink, captureFile, updateItemContent, deriveTitle, isProbablyUrl, CaptureError, DuplicateError } from "./capture";

describe("capture", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("derives titles from the first line", () => {
    expect(deriveTitle("# Meeting notes\n\nstuff")).toBe("Meeting notes");
    expect(deriveTitle("\n\n  plain first line here\nmore")).toBe("plain first line here");
    expect(deriveTitle("x".repeat(100))).toHaveLength(80);
    expect(deriveTitle("   ")).toBe("Untitled note");
  });

  it("detects a lone url", () => {
    expect(isProbablyUrl("https://example.com/a?b=1")).toBe(true);
    expect(isProbablyUrl("  http://x.io  ")).toBe(true);
    expect(isProbablyUrl("see https://example.com")).toBe(false);
    expect(isProbablyUrl("https://a.com\nhttps://b.com")).toBe(false);
  });

  it("captures a note with chunks, tags, and an embed job", () => {
    const item = captureNote(t.db, { body: "Buy tomato seeds\n\nAnd basil.", tags: ["Garden"] });
    expect(item.type).toBe("note");
    expect(item.title).toBe("Buy tomato seeds");
    expect(item.status).toBe("pending");
    expect(getItemTags(t.db, item.id)).toEqual(["garden"]);
    expect(getItemChunks(t.db, item.id)).toHaveLength(1);
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["embed"]);
  });

  it("captures a link and queues fetch_link, rejecting bad urls", () => {
    const item = captureLink(t.db, { url: "https://example.test/x" });
    expect(item.type).toBe("link");
    expect(item.title).toBe("https://example.test/x");
    expect(item.sourceUrl).toBe("https://example.test/x");
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["fetch_link"]);
    expect(() => captureLink(t.db, { url: "notaurl" })).toThrow(CaptureError);
    expect(() => captureLink(t.db, { url: "ftp://x.test/a" })).toThrow(/http/);
  });

  it("captures a pdf, an image, an unknown file, and rejects audio", () => {
    const pdf = captureFile(t.db, { bytes: MINIMAL_PDF, name: "hello.pdf", mime: "application/pdf" });
    expect(pdf.type).toBe("file");
    expect(fs.existsSync(absoluteFilePath(pdf.filePath!))).toBe(true);
    expect(listJobs(t.db, { itemId: pdf.id }).map((j) => j.type)).toEqual(["extract_pdf"]);

    const img = captureFile(t.db, { bytes: Buffer.from("png"), name: "a.png", mime: "image/png" });
    expect(listJobs(t.db, { itemId: img.id }).map((j) => j.type)).toEqual(["ocr_image"]);

    const other = captureFile(t.db, { bytes: Buffer.from("txt"), name: "notes.txt", mime: "text/plain" });
    expect(listJobs(t.db, { itemId: other.id }).map((j) => j.type)).toEqual(["embed"]);
    expect(getItemChunks(t.db, other.id)).toHaveLength(1);

    const call = captureFile(t.db, { bytes: Buffer.from("aud"), name: "call.m4a", mime: "audio/mp4" });
    expect(call.type).toBe("meeting");
    expect(call.title).toBe("call");
    expect(call.status).toBe("processing");
    expect(listJobs(t.db, { itemId: call.id }).map((j) => j.type)).toEqual(["transcribe_final"]);
  });

  it("updates content, rechunks, retags, and requeues embedding", () => {
    const item = captureNote(t.db, { body: "first version" });
    const updated = updateItemContent(t.db, item.id, { title: "Renamed", body: "second version", tags: ["b", "a"] });
    expect(updated.title).toBe("Renamed");
    expect(getItemChunks(t.db, item.id)[0].text).toBe("Renamed second version");
    expect(getItemTags(t.db, item.id)).toEqual(["a", "b"]);
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["embed", "embed"]);
    expect(() => updateItemContent(t.db, 999, { body: "x" })).toThrow(CaptureError);
  });

  it("captures into a container and rejects duplicate links unless forced", () => {
    const now = new Date().toISOString();
    t.db.$client
      .prepare("INSERT INTO containers (kind, name, slug, created_at, updated_at) VALUES ('project', 'P', 'p', ?, ?)")
      .run(now, now);
    const containerId = (t.db.$client.prepare("SELECT id FROM containers WHERE slug = 'p'").get() as { id: number }).id;

    const note = captureNote(t.db, { body: "homed note", containerId });
    expect(note.containerId).toBe(containerId);
    const first = captureLink(t.db, { url: "https://example.test/dup?utm_source=a", containerId });
    expect(first.containerId).toBe(containerId);
    try {
      captureLink(t.db, { url: "https://example.test/dup" });
      throw new Error("expected DuplicateError");
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateError);
      expect((e as DuplicateError).status).toBe(409);
      expect((e as DuplicateError).existingId).toBe(first.id);
    }
    const forced = captureLink(t.db, { url: "https://example.test/dup", force: true });
    expect(forced.id).not.toBe(first.id);
    const file = captureFile(t.db, { bytes: Buffer.from("t"), name: "n.txt", mime: "text/plain", containerId });
    expect(file.containerId).toBe(containerId);
  });

  it("rejects a nonexistent containerId with a 400 CaptureError", () => {
    try {
      captureNote(t.db, { body: "x", containerId: 9999 });
      throw new Error("expected CaptureError");
    } catch (e) {
      expect(e).toBeInstanceOf(CaptureError);
      expect((e as CaptureError).status).toBe(400);
    }
  });
});

describe("captureFile and a text document", () => {
  /* The silent gap this closes: a `.md` file used to be saved, chunked from `title + body +
   * extractedText` -- all three empty for a file -- and indexed as zero chunks. It showed up in
   * the library, it opened, and no word inside it would ever find it. A watched folder feeding
   * that pipeline would have been a folder that swallowed documents. */
  it("reads the words in so the thing can actually be found", () => {
    const t = makeTestDb();
    try {
      const item = captureFile(t.db, {
        bytes: Buffer.from("# Migration plan\n\nFreeze schema changes until the audit finishes.", "utf8"),
        name: "migration-plan.md",
        mime: "text/markdown",
      });
      expect(item.extractedText).toContain("Freeze schema changes");
      expect(getItemChunks(t.db, item.id).length).toBeGreaterThan(0);
    } finally {
      t.cleanup();
    }
  });

  it("leaves a binary file's bytes alone", () => {
    const t = makeTestDb();
    try {
      const item = captureFile(t.db, { bytes: Buffer.from([0x00, 0x01, 0x02]), name: "thing.bin", mime: "application/octet-stream" });
      expect(item.extractedText).toBe("");
    } finally {
      t.cleanup();
    }
  });
});
