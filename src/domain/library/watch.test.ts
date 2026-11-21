import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeTestDb, type TestDb } from "@/test/db";
import { items } from "@/db/schema";
import { getItemChunks } from "@/domain/items";
import { setSetting } from "@/domain/settings";
import { DROP_DIR_SETTING, ingestDropFolder } from "./watch";

let t: TestDb;
let drop: string;
afterEach(() => {
  t?.cleanup();
  if (drop) fs.rmSync(drop, { recursive: true, force: true });
});

const NOW = new Date("2026-11-21T12:00:00.000Z");

function folder(): string {
  drop = fs.mkdtempSync(path.join(os.tmpdir(), "sb-drop-"));
  t = makeTestDb();
  setSetting(t.db, DROP_DIR_SETTING, drop);
  return drop;
}

const write = (name: string, body: string) => {
  const full = path.join(drop, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

const titles = () => t.db.select({ title: items.title }).from(items).all().map((r) => r.title).sort();

describe("ingestDropFolder", () => {
  it("takes in a document and indexes its words", () => {
    folder();
    write("migration-plan.md", "# Migration plan\n\nFreeze schema changes until the audit finishes.");
    expect(ingestDropFolder(t.db, NOW)).toMatchObject({ ingested: 1, failures: [] });
    const item = t.db.select().from(items).get()!;
    expect(item.extractedText).toContain("Freeze schema changes");
    expect(getItemChunks(t.db, item.id).length).toBeGreaterThan(0);
  });

  /* The folder is re-read every few minutes. Without this it would ingest the same documents
   * forever and the library would be nothing but duplicates of itself. */
  it("does not take the same file in twice", () => {
    folder();
    write("spec.md", "the spec");
    ingestDropFolder(t.db, NOW);
    expect(ingestDropFolder(t.db, NOW)).toMatchObject({ ingested: 0, skipped: 1 });
    expect(titles()).toEqual(["spec.md"]);
  });

  /* Matching on the path alone would leave the knowledge base holding last week's version of a
   * document somebody has since rewritten, with nothing to say it was stale. */
  it("takes it in again once it has actually changed", () => {
    folder();
    const file = write("spec.md", "the spec");
    ingestDropFolder(t.db, NOW);
    fs.writeFileSync(file, "the spec, rewritten and considerably longer than before");
    fs.utimesSync(file, new Date("2026-11-22T12:00:00.000Z"), new Date("2026-11-22T12:00:00.000Z"));
    expect(ingestDropFolder(t.db, NOW).ingested).toBe(1);
  });

  it("reaches into subfolders but not forever", () => {
    folder();
    write("a/b/deep.md", "three levels is fine");
    write("a/b/c/d/too-deep.md", "five is not");
    ingestDropFolder(t.db, NOW);
    expect(titles()).toEqual(["deep.md"]);
  });

  /* Without this, the first pass over any folder a Mac user has opened in Finder ingests its
   * .DS_Store -- and then every dotfile in it. */
  it("ignores the noise every real folder has", () => {
    folder();
    write(".DS_Store", "finder junk");
    write(".hidden", "not dropped on purpose");
    write("real.md", "this one was");
    ingestDropFolder(t.db, NOW);
    expect(titles()).toEqual(["real.md"]);
  });

  it("skips an empty file", () => {
    folder();
    write("empty.md", "");
    expect(ingestDropFolder(t.db, NOW)).toMatchObject({ ingested: 0, skipped: 1 });
  });

  /* One unreadable document must not stop the pass. A folder you have to supervise is a folder
   * you are still doing the work for. */
  it("names what it could not read and takes the rest anyway", () => {
    folder();
    const bad = write("locked.md", "secret");
    write("fine.md", "readable");
    fs.chmodSync(bad, 0o000);
    try {
      const out = ingestDropFolder(t.db, NOW);
      expect(out.ingested).toBe(1);
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0].file).toBe(bad);
      expect(titles()).toEqual(["fine.md"]);
    } finally {
      fs.chmodSync(bad, 0o600);
    }
  });

  it("does nothing at all when the folder is not there", () => {
    folder();
    fs.rmSync(drop, { recursive: true, force: true });
    expect(ingestDropFolder(t.db, NOW)).toEqual({ ingested: 0, skipped: 0, failures: [] });
  });

  it("holds one pass to a bounded number of files", () => {
    folder();
    for (let i = 0; i < 30; i++) write(`doc-${i}.md`, `document number ${i}`);
    expect(ingestDropFolder(t.db, NOW).ingested).toBe(25);
    expect(ingestDropFolder(t.db, NOW).ingested).toBe(5);
  });
});
