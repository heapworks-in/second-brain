import { describe, it, expect, afterEach, vi } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { PROPOSAL_KINDS } from "@/db/enums";
import { GENERATORS, collectDrafts } from "./index";

let t: TestDb;
afterEach(() => {
  t?.cleanup();
  vi.restoreAllMocks();
});

describe("GENERATORS", () => {
  it("covers every kind the schema allows, exactly once", () => {
    expect(GENERATORS.map((g) => g.name).sort()).toEqual([...PROPOSAL_KINDS].sort());
  });

  it("produces nothing at all on an empty database rather than failing", () => {
    t = makeTestDb();
    expect(collectDrafts(t.db, new Date("2026-11-08T09:00:00.000Z"))).toEqual([]);
  });
});

describe("collectDrafts", () => {
  /** A desk that goes blank because one query met data it did not expect is the kind of failure
   * that gets a feature switched off for good. */
  it("keeps the other generators when one throws, and says which", () => {
    t = makeTestDb();
    const logged: string[] = [];
    const [first] = GENERATORS;
    vi.spyOn(first, "run").mockImplementation(() => {
      throw new Error("nope");
    });
    expect(collectDrafts(t.db, new Date("2026-11-08T09:00:00.000Z"), (m) => logged.push(m))).toEqual([]);
    expect(logged).toEqual([`${first.name} failed: nope`]);
  });
});
