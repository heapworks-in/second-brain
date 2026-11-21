import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "@/test/db";
import { saveFile, absoluteFilePath, kindForMime } from "./files";

describe("files", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDataDir();
  });

  it("saves under files/YYYY/MM with a uuid prefix and a safe name", () => {
    const saved = saveFile(Buffer.from("hello"), "My Report (final).pdf", new Date("2026-09-12T10:00:00Z"));
    expect(saved.relativePath).toMatch(/^2026\/09\/[0-9a-f-]{36}-My_Report_final_.pdf$/);
    expect(saved.absolutePath).toBe(path.join(dir, "files", saved.relativePath));
    expect(fs.readFileSync(saved.absolutePath, "utf8")).toBe("hello");
    expect(absoluteFilePath(saved.relativePath)).toBe(saved.absolutePath);
  });

  it("classifies files by mime type with extension fallback", () => {
    expect(kindForMime("application/pdf", "x.bin")).toBe("pdf");
    expect(kindForMime("application/octet-stream", "x.PDF")).toBe("pdf");
    expect(kindForMime("image/png", "a.png")).toBe("image");
    expect(kindForMime("audio/mpeg", "a.mp3")).toBe("audio");
    expect(kindForMime("application/octet-stream", "call.m4a")).toBe("audio");
    // Was "other", which was the bug: a text file took the binary path, so its words never
    // reached `extractedText`, nothing was chunked, and the document was in the library but
    // unfindable by any word inside it.
    expect(kindForMime("text/plain", "notes.txt")).toBe("text");
    expect(kindForMime("", "plan.md")).toBe("text");
    expect(kindForMime("application/octet-stream", "thing.bin")).toBe("other");
  });
});
